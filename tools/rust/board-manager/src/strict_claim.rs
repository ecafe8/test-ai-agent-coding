//! Conservative claim ownership checks for a future portable execution path.
//!
//! This is separate from the existing worker's claim replay. A successful check
//! confirms only a momentary claim snapshot, not task authorization or readiness.

use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::HashSet;

use crate::approval::author_key;
use crate::claims::{self, ClaimEvent, EventKind};
use crate::error::{BoardError, Result};
use crate::models::{AgentClaim, same_agent};

fn checked_events(
    data: &Value,
    authors: &HashSet<String>,
    now: DateTime<Utc>,
) -> Result<Vec<ClaimEvent>> {
    let comments = data
        .get("repository")
        .and_then(|r| r.get("issue"))
        .filter(|issue| !issue.is_null())
        .and_then(|issue| issue.get("comments"))
        .ok_or_else(|| BoardError::GraphQL("Claim history unavailable".into()))?;
    match comments
        .get("pageInfo")
        .and_then(|page| page.get("hasPreviousPage"))
        .and_then(Value::as_bool)
    {
        Some(false) => {},
        Some(true) => return Err(BoardError::Validation("Claim history is incomplete".into())),
        None => return Err(BoardError::GraphQL("Claim pagination unavailable".into())),
    }
    let nodes = comments
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| BoardError::GraphQL("Claim comments unavailable".into()))?;

    let mut events = Vec::new();
    let mut last_time: Option<DateTime<Utc>> = None;
    for node in nodes {
        let body = node
            .get("body")
            .and_then(Value::as_str)
            .ok_or_else(|| BoardError::GraphQL("Claim comment body unavailable".into()))?;
        if ![
            claims::CLAIM_PREFIX,
            claims::RENEWAL_PREFIX,
            claims::RELEASE_PREFIX,
        ]
        .iter()
        .any(|marker| body.contains(marker))
        {
            continue;
        }
        let author = node.get("author").filter(|author| !author.is_null());
        let author_type = author
            .and_then(|author| author.get("__typename"))
            .and_then(Value::as_str);
        if !matches!(author_type, Some("User" | "Bot")) {
            return Err(BoardError::GraphQL(
                "Claim author identity unavailable".into(),
            ));
        }
        let key = author_key(node)
            .ok_or_else(|| BoardError::GraphQL("Claim author identity unavailable".into()))?;
        if !authors.contains(&key) {
            continue;
        }
        let at = node
            .get("createdAt")
            .and_then(Value::as_str)
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc))
            .ok_or_else(|| BoardError::GraphQL("Claim timestamp unavailable".into()))?;
        if at > now || last_time.is_some_and(|previous| at < previous) {
            return Err(BoardError::Validation(
                "Claim timestamps are inconsistent".into(),
            ));
        }
        last_time = Some(at);
        let event = claims::parse_event(body, Some(at))
            .ok_or_else(|| BoardError::Validation("Malformed trusted claim event".into()))?;
        events.push(event);
    }
    Ok(events)
}

/// A claim at or after the approval timestamp makes it unsuitable for reuse.
pub fn approval_unused(
    data: &Value,
    authors: &HashSet<String>,
    approved_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<bool> {
    if approved_at > now {
        return Err(BoardError::Validation(
            "Approval timestamp is in the future".into(),
        ));
    }
    Ok(!checked_events(data, authors, now)?
        .iter()
        .any(|event| event.kind == EventKind::Claim && event.at >= approved_at))
}

/// Parse complete claim history and decide whether the exact session still owns it.
pub fn owns_claim(
    data: &Value,
    issue_number: u64,
    agent: &str,
    session: &str,
    authors: &HashSet<String>,
    timeout: i64,
    now: DateTime<Utc>,
) -> Result<bool> {
    if issue_number == 0 || agent.trim().is_empty() || session.trim().is_empty() || timeout <= 0 {
        return Err(BoardError::Validation(
            "Invalid claim check parameters".into(),
        ));
    }
    let mut active: Option<AgentClaim> = None;
    for event in checked_events(data, authors, now)? {
        let at = event.at;
        match event.kind {
            EventKind::Release => active = None,
            EventKind::Renewal => {
                if let Some(claim) = active.as_mut()
                    && same_agent(&claim.agent, &event.agent)
                {
                    if event.session_id.as_deref() != Some(&claim.session_id) {
                        return Err(BoardError::Validation(
                            "Ambiguous claim renewal session".into(),
                        ));
                    }
                    if claim.is_expired_at(timeout, at) {
                        return Err(BoardError::Validation(
                            "Expired claim cannot be renewed".into(),
                        ));
                    }
                    claim.renewed_at = Some(at);
                }
            },
            EventKind::Claim => {
                let event_session = event
                    .session_id
                    .as_deref()
                    .ok_or_else(|| BoardError::Validation("Claim session unavailable".into()))?;
                match active.as_mut() {
                    Some(claim) if claim.session_id == event_session => {
                        if !same_agent(&claim.agent, &event.agent) {
                            return Err(BoardError::Validation(
                                "Ambiguous claim session agent".into(),
                            ));
                        }
                        if claim.is_expired_at(timeout, at) {
                            return Err(BoardError::Validation(
                                "Expired claim cannot be renewed".into(),
                            ));
                        }
                        claim.renewed_at = Some(at);
                    },
                    Some(claim) if !claim.is_expired_at(timeout, at) => {},
                    _ => {
                        active = Some(AgentClaim {
                            issue_number,
                            agent: event.agent,
                            session_id: event_session.to_string(),
                            timestamp: at,
                            renewed_at: None,
                        });
                    },
                }
            },
        }
    }
    Ok(active.is_some_and(|claim| {
        same_agent(&claim.agent, agent)
            && claim.session_id == session
            && !claim.is_expired_at(timeout, now)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn time(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn node(body: String, at: &str, login: &str) -> Value {
        json!({ "body": body, "createdAt": at, "author": { "__typename": "User", "login": login } })
    }

    fn history(nodes: Vec<Value>, previous: bool) -> Value {
        json!({ "repository": { "issue": { "comments": { "pageInfo": { "hasPreviousPage": previous }, "nodes": nodes } } } })
    }

    fn check(data: &Value, agent: &str, session: &str, now: &str) -> Result<bool> {
        owns_claim(
            data,
            42,
            agent,
            session,
            &HashSet::from(["admin".into()]),
            3600,
            time(now),
        )
    }

    fn claim(agent: &str, session: &str, at: &str, login: &str) -> Value {
        node(
            claims::claim_comment(agent, session, time(at), 3600),
            at,
            login,
        )
    }

    fn renewal(agent: &str, session: &str, at: &str) -> Value {
        node(
            claims::renewal_comment(agent, session, time(at)),
            at,
            "admin",
        )
    }

    #[test]
    fn requires_exact_live_agent_and_session() {
        let data = history(
            vec![claim("opencode", "run-1", "2026-01-01T00:00:00Z", "admin")],
            false,
        );
        assert!(check(&data, "opencode", "run-1", "2026-01-01T00:30:00Z").unwrap());
        assert!(!check(&data, "opencode", "run-2", "2026-01-01T00:30:00Z").unwrap());
        assert!(!check(&data, "crush", "run-1", "2026-01-01T00:30:00Z").unwrap());
        assert!(!check(&data, "opencode", "run-1", "2026-01-01T01:00:01Z").unwrap());
        assert!(check(&data, "opencode", "", "2026-01-01T00:30:00Z").is_err());
    }

    #[test]
    fn missing_or_incomplete_sources_fail_closed() {
        for data in [
            json!({}),
            json!({"repository":{"issue":null}}),
            json!({"repository":{"issue":{"comments":{"nodes":[]}}}}),
            json!({"repository":{"issue":{"comments":{"pageInfo":{"hasPreviousPage":false}}}}}),
            history(vec![], true),
        ] {
            assert!(check(&data, "opencode", "run-1", "2026-01-01T00:30:00Z").is_err());
        }
        assert!(
            !check(
                &history(vec![], false),
                "opencode",
                "run-1",
                "2026-01-01T00:30:00Z"
            )
            .unwrap()
        );
    }

    #[test]
    fn untrusted_claims_cannot_gain_or_release_ownership() {
        let release = node(
            claims::release_comment("opencode", "completed", time("2026-01-01T00:05:00Z"), ""),
            "2026-01-01T00:05:00Z",
            "attacker",
        );
        let data = history(
            vec![
                claim("opencode", "evil", "2026-01-01T00:00:00Z", "attacker"),
                claim("opencode", "run-1", "2026-01-01T00:01:00Z", "admin"),
                release,
            ],
            false,
        );
        assert!(check(&data, "opencode", "run-1", "2026-01-01T00:30:00Z").unwrap());
        assert!(!check(&data, "opencode", "evil", "2026-01-01T00:30:00Z").unwrap());
    }

    #[test]
    fn first_live_claim_wins_and_trusted_release_clears() {
        let first = claim("opencode", "run-1", "2026-01-01T00:00:00Z", "admin");
        let second = claim("crush", "run-2", "2026-01-01T00:01:00Z", "admin");
        let data = history(vec![first.clone(), second.clone()], false);
        assert!(check(&data, "opencode", "run-1", "2026-01-01T00:10:00Z").unwrap());
        assert!(!check(&data, "crush", "run-2", "2026-01-01T00:10:00Z").unwrap());
        let release = node(
            claims::release_comment("crush", "completed", time("2026-01-01T00:02:00Z"), ""),
            "2026-01-01T00:02:00Z",
            "admin",
        );
        let data = history(vec![first, second, release], false);
        assert!(!check(&data, "opencode", "run-1", "2026-01-01T00:10:00Z").unwrap());
    }

    #[test]
    fn matching_renewal_extends_but_other_session_is_ambiguous() {
        let first = claim("opencode", "run-1", "2026-01-01T00:00:00Z", "admin");
        let data = history(
            vec![
                first.clone(),
                renewal("opencode", "run-1", "2026-01-01T00:50:00Z"),
            ],
            false,
        );
        assert!(check(&data, "opencode", "run-1", "2026-01-01T01:20:00Z").unwrap());
        let wrong = history(
            vec![
                first.clone(),
                renewal("opencode", "run-2", "2026-01-01T00:50:00Z"),
            ],
            false,
        );
        assert!(check(&wrong, "opencode", "run-1", "2026-01-01T01:20:00Z").is_err());
        let late = history(
            vec![first, renewal("opencode", "run-1", "2026-01-01T01:01:00Z")],
            false,
        );
        assert!(check(&late, "opencode", "run-1", "2026-01-01T01:20:00Z").is_err());
    }

    #[test]
    fn invalid_identity_time_and_trusted_events_fail_closed() {
        let original = claim("opencode", "run-1", "2026-01-01T00:00:00Z", "admin");
        let mut missing_author = original.clone();
        missing_author["author"] = Value::Null;
        let mut missing_time = original.clone();
        missing_time["createdAt"] = Value::Null;
        let malformed = node("**[Agent Claim]**".into(), "2026-01-01T00:00:00Z", "admin");
        for node in [missing_author, missing_time, malformed] {
            assert!(
                check(
                    &history(vec![node], false),
                    "opencode",
                    "run-1",
                    "2026-01-01T00:30:00Z"
                )
                .is_err()
            );
        }
        assert!(
            check(
                &history(vec![original.clone()], false),
                "opencode",
                "run-1",
                "2025-12-31T23:59:59Z"
            )
            .is_err()
        );
        let older = renewal("opencode", "run-1", "2025-12-31T23:59:59Z");
        assert!(
            check(
                &history(vec![original, older], false),
                "opencode",
                "run-1",
                "2026-01-01T00:30:00Z"
            )
            .is_err()
        );
    }

    #[test]
    fn bot_claims_require_bot_identity_and_session_reuse_is_checked() {
        let body = claims::claim_comment("opencode", "run-1", time("2026-01-01T00:00:00Z"), 3600);
        let bot = json!({"body": body, "createdAt": "2026-01-01T00:00:00Z", "author": {"__typename": "Bot", "login": "github-actions"}});
        let authors = HashSet::from(["github-actions[bot]".into()]);
        let now = time("2026-01-01T00:30:00Z");
        assert!(
            owns_claim(
                &history(vec![bot.clone()], false),
                42,
                "opencode",
                "run-1",
                &authors,
                3600,
                now
            )
            .unwrap()
        );
        let mut human = bot;
        human["author"]["__typename"] = json!("User");
        assert!(
            !owns_claim(
                &history(vec![human], false),
                42,
                "opencode",
                "run-1",
                &authors,
                3600,
                now
            )
            .unwrap()
        );

        let first = claim("opencode", "run-1", "2026-01-01T00:00:00Z", "admin");
        let reused = claim("crush", "run-1", "2026-01-01T00:05:00Z", "admin");
        assert!(
            check(
                &history(vec![first.clone(), reused], false),
                "opencode",
                "run-1",
                "2026-01-01T00:30:00Z"
            )
            .is_err()
        );
        let late = claim("opencode", "run-1", "2026-01-01T01:01:00Z", "admin");
        assert!(
            check(
                &history(vec![first, late], false),
                "opencode",
                "run-1",
                "2026-01-01T01:20:00Z"
            )
            .is_err()
        );
    }

    #[test]
    fn approval_reuse_check_rejects_trusted_claims_at_or_after_approval() {
        let authors = HashSet::from(["admin".into()]);
        let approved = time("2026-01-01T00:10:00Z");
        let now = time("2026-01-01T00:30:00Z");
        let before = claim("opencode", "old", "2026-01-01T00:09:59Z", "admin");
        let at = claim("opencode", "run-1", "2026-01-01T00:10:00Z", "admin");
        let forged = claim("opencode", "evil", "2026-01-01T00:11:00Z", "attacker");
        assert!(
            approval_unused(
                &history(vec![before.clone(), forged], false),
                &authors,
                approved,
                now
            )
            .unwrap()
        );
        assert!(
            !approval_unused(&history(vec![before, at], false), &authors, approved, now).unwrap()
        );
        assert!(approval_unused(&history(vec![], true), &authors, approved, now).is_err());
        assert!(
            approval_unused(
                &history(vec![], false),
                &authors,
                time("2026-01-01T00:31:00Z"),
                now
            )
            .is_err()
        );
    }
}
