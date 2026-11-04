//! Narrow, read-only board preflight for one repository-bound issue.
//!
//! This is not a task authorization or a claim. It deliberately refuses any
//! blocker instead of guessing at cross-repository dependency identities.

use serde_json::Value;

use crate::error::{BoardError, Result};
use crate::models::{BoardConfig, IssueStatus, same_agent};

fn unavailable(what: &str) -> BoardError {
    BoardError::GraphQL(format!("Strict board preflight: {what}"))
}

fn complete_nodes<'a>(connection: &'a Value, what: &str) -> Result<&'a Vec<Value>> {
    match connection
        .get("pageInfo")
        .and_then(|v| v.get("hasNextPage"))
        .and_then(Value::as_bool)
    {
        Some(false) => {},
        Some(true) => return Err(unavailable(&format!("{what} is incomplete"))),
        None => return Err(unavailable(&format!("{what} pagination unavailable"))),
    }
    connection
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| unavailable(&format!("{what} unavailable")))
}

fn optional_field<'a>(item: &'a Value, key: &str) -> Result<Option<&'a Value>> {
    let value = item
        .get(key)
        .ok_or_else(|| unavailable(&format!("{key} field unavailable")))?;
    Ok((!value.is_null()).then_some(value))
}

fn field_text<'a>(value: &'a Value, expected: &[(&str, &str)]) -> Result<&'a str> {
    let kind = value
        .get("__typename")
        .and_then(Value::as_str)
        .ok_or_else(|| unavailable("field type unavailable"))?;
    let key = expected
        .iter()
        .find(|(name, _)| *name == kind)
        .map(|(_, key)| *key)
        .ok_or_else(|| unavailable("unexpected field type"))?;
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| unavailable("field value unavailable"))
}

/// Validate only the board snapshot; approval and claim checks are separate.
pub fn is_ready(
    data: &Value,
    config: &BoardConfig,
    expected_repo: &str,
    issue_number: u64,
    project_id: &str,
    agent: &str,
    expected_status: IssueStatus,
) -> Result<bool> {
    if issue_number == 0
        || project_id.trim().is_empty()
        || agent.trim().is_empty()
        || config.repo_parts().is_none()
        || !config.repository.eq_ignore_ascii_case(expected_repo)
    {
        return Err(BoardError::Validation(
            "Invalid strict board preflight target".into(),
        ));
    }
    let repo = data
        .get("repository")
        .filter(|v| !v.is_null())
        .ok_or_else(|| unavailable("repository unavailable"))?;
    let name = repo
        .get("nameWithOwner")
        .and_then(Value::as_str)
        .ok_or_else(|| unavailable("repository identity unavailable"))?;
    if !name.eq_ignore_ascii_case(expected_repo) {
        return Err(unavailable("repository identity mismatch"));
    }
    let issue = repo
        .get("issue")
        .ok_or_else(|| unavailable("issue unavailable"))?;
    if issue.is_null() {
        return Ok(false);
    }
    if issue.get("number").and_then(Value::as_u64) != Some(issue_number) {
        return Err(unavailable("issue identity mismatch"));
    }
    let state = issue
        .get("state")
        .and_then(Value::as_str)
        .ok_or_else(|| unavailable("issue state unavailable"))?;
    if state != "OPEN" && state != "CLOSED" {
        return Err(unavailable("invalid issue state"));
    }
    if state != "OPEN" {
        return Ok(false);
    }
    let labels = complete_nodes(
        issue
            .get("labels")
            .ok_or_else(|| unavailable("labels unavailable"))?,
        "labels",
    )?;
    for label in labels {
        let name = label
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| unavailable("label name unavailable"))?;
        if config
            .exclude_labels
            .iter()
            .any(|excluded| excluded.eq_ignore_ascii_case(name))
        {
            return Ok(false);
        }
    }
    let items = complete_nodes(
        issue
            .get("projectItems")
            .ok_or_else(|| unavailable("project items unavailable"))?,
        "project items",
    )?;
    let mut matched = None;
    for item in items {
        let id = item
            .get("project")
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| unavailable("project identity unavailable"))?;
        if id == project_id && matched.replace(item).is_some() {
            return Err(unavailable("duplicate project items"));
        }
    }
    let Some(item) = matched else {
        return Ok(false);
    };
    item.get("id")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| unavailable("project item identity unavailable"))?;
    let Some(status) = optional_field(item, "status")? else {
        return Ok(false);
    };
    let status = field_text(status, &[("ProjectV2ItemFieldSingleSelectValue", "name")])?;
    let parsed = status
        .parse::<IssueStatus>()
        .map_err(|_| unavailable("unrecognized board status"))?;
    if parsed != expected_status {
        return Ok(false);
    }
    if let Some(assignment) = optional_field(item, "agent")? {
        let assigned = field_text(
            assignment,
            &[
                ("ProjectV2ItemFieldSingleSelectValue", "name"),
                ("ProjectV2ItemFieldTextValue", "text"),
            ],
        )?;
        if !assigned.trim().is_empty() && !same_agent(assigned, agent) {
            return Ok(false);
        }
    }
    if let Some(blockers) = optional_field(item, "blockers")? {
        let blockers = field_text(blockers, &[("ProjectV2ItemFieldTextValue", "text")])?;
        if !blockers.trim().is_empty() {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> BoardConfig {
        BoardConfig {
            repository: "owner/repo".into(),
            exclude_labels: vec!["no-agent".into()],
            ..Default::default()
        }
    }

    fn fixture() -> Value {
        json!({"repository": {"nameWithOwner": "owner/repo", "issue": {
            "number": 42, "state": "OPEN",
            "labels": {"pageInfo": {"hasNextPage": false}, "nodes": []},
            "projectItems": {"pageInfo": {"hasNextPage": false}, "nodes": [{
                "id": "ITEM1", "project": {"id": "PROJECT1"},
                "status": {"__typename": "ProjectV2ItemFieldSingleSelectValue", "name": "Todo"},
                "agent": null, "blockers": null
            }]}
        }}})
    }

    fn check(data: &Value) -> Result<bool> {
        is_ready(
            data,
            &config(),
            "owner/repo",
            42,
            "PROJECT1",
            "opencode",
            IssueStatus::Todo,
        )
    }

    #[test]
    fn ready_requires_exact_repo_issue_project_and_todo() {
        let data = fixture();
        assert!(check(&data).unwrap());
        assert!(
            is_ready(
                &data,
                &config(),
                "OWNER/REPO",
                42,
                "PROJECT1",
                "opencode",
                IssueStatus::Todo
            )
            .unwrap()
        );
        assert!(
            !is_ready(
                &data,
                &config(),
                "owner/repo",
                42,
                "OTHER",
                "opencode",
                IssueStatus::Todo
            )
            .unwrap()
        );
        assert!(
            is_ready(
                &data,
                &config(),
                "other/repo",
                42,
                "PROJECT1",
                "opencode",
                IssueStatus::Todo
            )
            .is_err()
        );
        assert!(
            is_ready(
                &data,
                &config(),
                "owner/repo",
                43,
                "PROJECT1",
                "opencode",
                IssueStatus::Todo
            )
            .is_err()
        );
        let mut wrong = data;
        wrong["repository"]["nameWithOwner"] = json!("other/repo");
        assert!(check(&wrong).is_err());
    }

    #[test]
    fn denies_closed_excluded_wrong_agent_and_any_blockers() {
        let mut data = fixture();
        data["repository"]["issue"]["state"] = json!("CLOSED");
        assert!(!check(&data).unwrap());
        data = fixture();
        data["repository"]["issue"]["labels"]["nodes"] = json!([{"name":"NO-AGENT"}]);
        assert!(!check(&data).unwrap());
        data = fixture();
        data["repository"]["issue"]["projectItems"]["nodes"][0]["agent"] =
            json!({"__typename":"ProjectV2ItemFieldTextValue", "text":"crush"});
        assert!(!check(&data).unwrap());
        data["repository"]["issue"]["projectItems"]["nodes"][0]["agent"]["text"] =
            json!("opencode");
        assert!(check(&data).unwrap());
        data["repository"]["issue"]["projectItems"]["nodes"][0]["blockers"] =
            json!({"__typename":"ProjectV2ItemFieldTextValue", "text":"#7"});
        assert!(!check(&data).unwrap());
    }

    #[test]
    fn missing_unrecognized_or_duplicate_state_never_becomes_todo() {
        let mut data = fixture();
        data["repository"]["issue"]["projectItems"]["nodes"][0]["status"] = Value::Null;
        assert!(!check(&data).unwrap());
        data["repository"]["issue"]["projectItems"]["nodes"][0]["status"] =
            json!({"__typename":"ProjectV2ItemFieldSingleSelectValue", "name":"Unknown"});
        assert!(check(&data).is_err());
        data["repository"]["issue"]["projectItems"]["nodes"][0]["status"]["name"] =
            json!("In Progress");
        assert!(!check(&data).unwrap());
        data = fixture();
        let item = data["repository"]["issue"]["projectItems"]["nodes"][0].clone();
        data["repository"]["issue"]["projectItems"]["nodes"]
            .as_array_mut()
            .unwrap()
            .push(item);
        assert!(check(&data).is_err());
    }

    #[test]
    fn incomplete_or_malformed_connections_and_fields_fail_closed() {
        for pointer in [
            "/repository/issue/labels/pageInfo/hasNextPage",
            "/repository/issue/projectItems/pageInfo/hasNextPage",
        ] {
            let mut data = fixture();
            *data.pointer_mut(pointer).unwrap() = json!(true);
            assert!(check(&data).is_err());
            *data.pointer_mut(pointer).unwrap() = Value::Null;
            assert!(check(&data).is_err());
        }
        let mut data = fixture();
        data["repository"]["issue"]["projectItems"]["nodes"][0]
            .as_object_mut()
            .unwrap()
            .remove("agent");
        assert!(check(&data).is_err());
        data = fixture();
        data["repository"]["issue"]["projectItems"]["nodes"][0]["blockers"] =
            json!({"__typename":"Other", "text":""});
        assert!(check(&data).is_err());
        data = fixture();
        data["repository"]["issue"]["projectItems"]["nodes"][0]["project"] = Value::Null;
        assert!(check(&data).is_err());
        data = fixture();
        data["repository"]["issue"]["labels"]["nodes"] = json!([{}]);
        assert!(check(&data).is_err());
    }

    #[test]
    fn running_check_requires_in_progress_instead_of_todo() {
        let mut data = fixture();
        assert!(
            !is_ready(
                &data,
                &config(),
                "owner/repo",
                42,
                "PROJECT1",
                "opencode",
                IssueStatus::InProgress
            )
            .unwrap()
        );
        data["repository"]["issue"]["projectItems"]["nodes"][0]["status"]["name"] =
            json!("In Progress");
        assert!(
            is_ready(
                &data,
                &config(),
                "owner/repo",
                42,
                "PROJECT1",
                "opencode",
                IssueStatus::InProgress
            )
            .unwrap()
        );
        assert!(!check(&data).unwrap());
    }
}
