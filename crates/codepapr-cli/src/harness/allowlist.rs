//! Permission allowlist for `codepapr run --permission <file>`.
//!
//! File format: a JSON array of rules. A permission request is approved when
//! ANY rule matches. A rule matches when every field it specifies matches:
//!
//! ```json
//! [
//!   { "tool": "write", "pathGlob": "src/**" },
//!   { "tool": "bash", "operation": "command", "pathContains": "cargo test" },
//!   { "tool": "git" }
//! ]
//! ```
//!
//! Unknown fields are ignored; an empty rule `{}` matches everything (equivalent
//! to `--yolo` and rejected at load time to prevent accidents).

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub operation: Option<String>,
    #[serde(default)]
    pub path_glob: Option<String>,
    #[serde(default)]
    pub path_contains: Option<String>,
}

#[derive(Debug)]
pub enum AllowlistError {
    Read(std::path::PathBuf, std::io::Error),
    Parse(String),
    NotAnArray,
    EmptyRule(usize),
}

impl std::fmt::Display for AllowlistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AllowlistError::Read(path, source) => {
                write!(f, "failed to read allowlist {}: {source}", path.display())
            }
            AllowlistError::Parse(msg) => write!(f, "failed to parse allowlist: {msg}"),
            AllowlistError::NotAnArray => f.write_str("allowlist must be a JSON array of rules"),
            AllowlistError::EmptyRule(idx) => write!(
                f,
                "allowlist rule #{idx} is empty and would match everything; remove it or use --yolo"
            ),
        }
    }
}

impl std::error::Error for AllowlistError {}

#[derive(Debug, Clone, Default)]
pub struct Allowlist {
    rules: Vec<PermissionRule>,
}

impl Allowlist {
    pub fn load(path: &std::path::Path) -> Result<Self, AllowlistError> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| AllowlistError::Read(path.to_path_buf(), e))?;
        Self::parse(&text)
    }

    pub fn parse(text: &str) -> Result<Self, AllowlistError> {
        let value: serde_json::Value =
            serde_json::from_str(text).map_err(|e| AllowlistError::Parse(e.to_string()))?;
        let items = value.as_array().ok_or(AllowlistError::NotAnArray)?;
        let mut rules = Vec::with_capacity(items.len());
        for (idx, item) in items.iter().enumerate() {
            let rule: PermissionRule = serde_json::from_value(item.clone())
                .map_err(|e| AllowlistError::Parse(format!("rule #{idx}: {e}")))?;
            if rule.tool.is_none()
                && rule.operation.is_none()
                && rule.path_glob.is_none()
                && rule.path_contains.is_none()
            {
                return Err(AllowlistError::EmptyRule(idx));
            }
            rules.push(rule);
        }
        Ok(Self { rules })
    }

    /// Approve only when an explicit rule matches. Deny-by-default.
    pub fn is_allowed(&self, tool: Option<&str>, operation: Option<&str>, path: Option<&str>) -> bool {
        self.rules.iter().any(|rule| {
            rule.tool
                .as_ref()
                .map_or(true, |t| tool.map(|x| x == t.as_str()).unwrap_or(false))
                && rule
                    .operation
                    .as_ref()
                    .map_or(true, |o| operation.map(|x| x == o.as_str()).unwrap_or(false))
                && rule
                    .path_glob
                    .as_ref()
                    .map_or(true, |g| path.map(|p| glob_match(g, p)).unwrap_or(false))
                && rule
                    .path_contains
                    .as_ref()
                    .map_or(true, |c| path.map(|p| p.contains(c.as_str())).unwrap_or(false))
        })
    }
}

/// Minimal glob matcher (`*`, `?`, `**`), path-segment aware enough for the
/// allowlist use case. Avoids pulling a heavy dependency into the thin client.
fn glob_match(pattern: &str, text: &str) -> bool {
    let pat: Vec<char> = pattern.chars().collect();
    let txt: Vec<char> = text.chars().collect();
    matches_here(&pat, 0, &txt, 0)
}

fn matches_here(pat: &[char], mut pi: usize, txt: &[char], mut ti: usize) -> bool {
    loop {
        if pi == pat.len() {
            return ti == txt.len();
        }
        match pat[pi] {
            '*' => {
                // `**/` or `**` crosses separators; single `*` does not.
                let double_star = pat.get(pi + 1) == Some(&'*');
                let after = if double_star { pi + 2 } else { pi + 1 };
                // optional `/` right after `**`
                let after = if double_star && pat.get(after) == Some(&'/') { after + 1 } else { after };
                if !double_star {
                    for start in ti..=txt.len() {
                        if start > ti && txt[start - 1] == '/' {
                            break;
                        }
                        if matches_here(pat, after, txt, start) {
                            return true;
                        }
                    }
                    return false;
                }
                for start in ti..=txt.len() {
                    if matches_here(pat, after, txt, start) {
                        return true;
                    }
                }
                return false;
            }
            '?' => {
                if ti == txt.len() || txt[ti] == '/' {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
            c => {
                if ti == txt.len() || txt[ti] != c {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rules() {
        let a = Allowlist::parse(
            r#"[{"tool":"write","pathGlob":"src/**"},{"tool":"bash","pathContains":"cargo test"}]"#,
        )
        .unwrap();
        assert!(a.is_allowed(Some("write"), None, Some("src/app/main.rs")));
        assert!(!a.is_allowed(Some("write"), None, Some("docs/x.md")));
        assert!(a.is_allowed(Some("bash"), None, Some("cargo test -p x")));
        assert!(!a.is_allowed(Some("git"), None, None));
    }

    #[test]
    fn rejects_empty_rule() {
        assert!(matches!(
            Allowlist::parse("[{}]"),
            Err(AllowlistError::EmptyRule(0))
        ));
        assert!(matches!(Allowlist::parse("{}"), Err(AllowlistError::NotAnArray)));
    }

    #[test]
    fn operation_must_match_when_specified() {
        let a = Allowlist::parse(r#"[{"tool":"write","operation":"fileWrite"}]"#).unwrap();
        assert!(a.is_allowed(Some("write"), Some("fileWrite"), None));
        assert!(!a.is_allowed(Some("write"), Some("fileDelete"), None));
        // when the request carries no operation info, a rule requiring one must not match
        assert!(!a.is_allowed(Some("write"), None, None));
    }

    #[test]
    fn glob_semantics() {
        assert!(glob_match("src/**", "src/a/b.ts"));
        assert!(glob_match("**/*.rs", "crates/codepapr-cli/src/main.rs"));
        assert!(!glob_match("src/*", "src/a/b.ts"));
        assert!(glob_match("src/*", "src/a.ts"));
        assert!(glob_match("?.ts", "a.ts"));
        assert!(!glob_match("?.ts", "ab.ts"));
    }
}
