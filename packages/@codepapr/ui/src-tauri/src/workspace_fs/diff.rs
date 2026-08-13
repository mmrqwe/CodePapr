use super::types::WriteFileChangeSummary;

pub(crate) fn split_lines(content: &str) -> Vec<String> {
    if content.is_empty() {
        return Vec::new();
    }

    content
        .replace("\r\n", "\n")
        .split('\n')
        .map(|line| line.to_string())
        .collect()
}

pub(crate) fn compute_line_change_summary(
    existed_before: bool,
    before: Option<&str>,
    after: &str,
) -> WriteFileChangeSummary {
    let after_lines = split_lines(after);

    if !existed_before {
        return WriteFileChangeSummary {
            kind: "created".to_string(),
            added: after_lines.len(),
            deleted: 0,
            before_lines: 0,
            after_lines: after_lines.len(),
        };
    }

    let before_lines = split_lines(before.unwrap_or(""));
    let (added, deleted) = compute_line_diff_counts(&before_lines, &after_lines);

    WriteFileChangeSummary {
        kind: "updated".to_string(),
        added,
        deleted,
        before_lines: before_lines.len(),
        after_lines: after_lines.len(),
    }
}

/// 编辑距离超过该上限时（两个文件几乎完全不同），放弃精确 Myers 搜索，
/// 退化为 O(N+M) 的多重集近似统计。上限同时约束了最坏时间复杂度。
const MYERS_EDIT_DISTANCE_CAP: isize = 4096;

pub(crate) fn compute_line_diff_counts(
    before_lines: &[String],
    after_lines: &[String],
) -> (usize, usize) {
    // 公共前缀/后缀对变更计数没有贡献，先剥离以显著缩小参与 diff 的中段
    // （典型小编辑场景下中段往往只剩几十行）。
    let mut start = 0;
    while start < before_lines.len()
        && start < after_lines.len()
        && before_lines[start] == after_lines[start]
    {
        start += 1;
    }
    let mut before_end = before_lines.len();
    let mut after_end = after_lines.len();
    while before_end > start
        && after_end > start
        && before_lines[before_end - 1] == after_lines[after_end - 1]
    {
        before_end -= 1;
        after_end -= 1;
    }
    let middle_before = &before_lines[start..before_end];
    let middle_after = &after_lines[start..after_end];

    // 只需要编辑距离 D 即可推出增删行数（added + deleted = D，
    // added - deleted = after_len - before_len），无需保存完整 trace 回溯。
    // 旧实现保存 O(D²) 的 trace（每层一个 HashMap），万行级文件整体重写时
    // 会吃掉 GB 级内存并卡死写文件路径。
    match myers_edit_distance(middle_before, middle_after, MYERS_EDIT_DISTANCE_CAP) {
        Some(distance) => {
            let n = middle_before.len() as isize;
            let m = middle_after.len() as isize;
            let added = ((distance + m - n) / 2).max(0) as usize;
            let deleted = ((distance - m + n) / 2).max(0) as usize;
            (added, deleted)
        }
        None => multiset_diff_counts(middle_before, middle_after),
    }
}

/// Myers 最小编辑距离（只保留单条 frontier，内存 O(N+M)）。
/// 编辑距离超过 `cap` 时返回 None，由调用方决定退化策略。
fn myers_edit_distance(before: &[String], after: &[String], cap: isize) -> Option<isize> {
    let n = before.len() as isize;
    let m = after.len() as isize;
    if n == 0 && m == 0 {
        return Some(0);
    }
    let max_d = (n + m).min(cap);
    let offset = (max_d + 1) as isize;
    let mut frontier = vec![-1isize; (2 * offset + 1) as usize];
    frontier[(offset + 1) as usize] = 0;

    for depth in 0..=max_d {
        let mut diagonal = -depth;
        while diagonal <= depth {
            let index = (diagonal + offset) as usize;
            let down = frontier[index + 1];
            let right = frontier[index - 1];

            let mut x = if diagonal == -depth || (diagonal != depth && right < down) {
                down
            } else {
                right + 1
            };
            let mut y = x - diagonal;
            while x < n && y < m && before[x as usize] == after[y as usize] {
                x += 1;
                y += 1;
            }
            frontier[index] = x;

            if x >= n && y >= m {
                return Some(depth);
            }
            diagonal += 2;
        }
    }
    None
}

/// 多重集近似统计：O(N+M) 时间、O(N) 内存。移动的行会被计为未变更
/// （与精确 diff 不同），仅在编辑距离超出上限的"几乎整体重写"场景使用。
fn multiset_diff_counts(before: &[String], after: &[String]) -> (usize, usize) {
    use std::collections::HashMap;

    let mut remaining: HashMap<&str, isize> = HashMap::new();
    for line in before {
        *remaining.entry(line.as_str()).or_default() += 1;
    }
    let mut added = 0usize;
    for line in after {
        match remaining.get_mut(line.as_str()) {
            Some(count) if *count > 0 => *count -= 1,
            _ => added += 1,
        }
    }
    let deleted: usize = remaining
        .values()
        .filter_map(|count| (*count > 0).then_some(*count as usize))
        .sum();
    (added, deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn identical_content_has_no_changes() {
        let before = lines(&["a", "b", "c"]);
        assert_eq!(compute_line_diff_counts(&before, &before.clone()), (0, 0));
    }

    #[test]
    fn simple_edit_counts_are_exact() {
        let before = lines(&["a", "b", "c", "d"]);
        let after = lines(&["a", "x", "c", "d", "e"]);
        // b -> x 记为 1 删 1 增，e 为 1 增
        assert_eq!(compute_line_diff_counts(&before, &after), (2, 1));
    }

    #[test]
    fn created_from_empty_counts_all_added() {
        let after = lines(&["a", "b"]);
        assert_eq!(compute_line_diff_counts(&[], &after), (2, 0));
    }

    #[test]
    fn deleted_to_empty_counts_all_deleted() {
        let before = lines(&["a", "b"]);
        assert_eq!(compute_line_diff_counts(&before, &[]), (0, 2));
    }

    #[test]
    fn full_rewrite_falls_back_to_multiset() {
        // 完全不同的两段，编辑距离远超上限时走多重集退化
        let before: Vec<String> = (0..6000).map(|i| format!("old-{i}")).collect();
        let after: Vec<String> = (0..6000).map(|i| format!("new-{i}")).collect();
        assert_eq!(compute_line_diff_counts(&before, &after), (6000, 6000));
    }

    #[test]
    fn common_prefix_suffix_are_skipped() {
        let before = lines(&["head", "x", "y", "tail"]);
        let after = lines(&["head", "z", "tail"]);
        assert_eq!(compute_line_diff_counts(&before, &after), (1, 2));
    }
}
