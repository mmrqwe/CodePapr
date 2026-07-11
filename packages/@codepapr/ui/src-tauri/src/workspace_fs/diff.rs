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

pub(crate) fn compute_line_diff_counts(
    before_lines: &[String],
    after_lines: &[String],
) -> (usize, usize) {
    use std::collections::HashMap;

    let before_length = before_lines.len() as isize;
    let after_length = after_lines.len() as isize;
    let max_depth = before_length + after_length;
    let mut frontier: HashMap<isize, isize> = HashMap::new();
    let mut trace: Vec<HashMap<isize, isize>> = Vec::new();

    frontier.insert(1, 0);

    for depth in 0..=max_depth {
        let mut current = HashMap::new();
        let mut diagonal = -depth;

        while diagonal <= depth {
            let down = *frontier.get(&(diagonal + 1)).unwrap_or(&0);
            let right = *frontier.get(&(diagonal - 1)).unwrap_or(&-1);

            let mut x = if diagonal == -depth || (diagonal != depth && right < down) {
                down
            } else {
                right + 1
            };

            let mut y = x - diagonal;
            while x < before_length
                && y < after_length
                && before_lines[x as usize] == after_lines[y as usize]
            {
                x += 1;
                y += 1;
            }

            current.insert(diagonal, x);

            if x >= before_length && y >= after_length {
                trace.push(current);
                return backtrack_line_diff(&trace, before_lines.len(), after_lines.len());
            }

            diagonal += 2;
        }

        frontier = current.clone();
        trace.push(current);
    }

    (after_lines.len(), before_lines.len())
}

pub(crate) fn backtrack_line_diff(
    trace: &[std::collections::HashMap<isize, isize>],
    before_length: usize,
    after_length: usize,
) -> (usize, usize) {
    let mut x = before_length as isize;
    let mut y = after_length as isize;
    let mut added = 0usize;
    let mut deleted = 0usize;

    for depth in (1..trace.len()).rev() {
        let previous = &trace[depth - 1];
        let depth = depth as isize;
        let diagonal = x - y;
        let down = *previous.get(&(diagonal + 1)).unwrap_or(&0);
        let right = *previous.get(&(diagonal - 1)).unwrap_or(&-1);
        let previous_diagonal = if diagonal == -depth || (diagonal != depth && right < down) {
            diagonal + 1
        } else {
            diagonal - 1
        };
        let previous_x = *previous.get(&previous_diagonal).unwrap_or(&0);
        let previous_y = previous_x - previous_diagonal;

        while x > previous_x && y > previous_y {
            x -= 1;
            y -= 1;
        }

        if x == previous_x {
            y -= 1;
            added += 1;
        } else {
            x -= 1;
            deleted += 1;
        }
    }

    (added, deleted)
}
