/**
 * Project Health Intelligence Engine (Phase 5).
 * 
 * Analyzes:
 * 1. Issues & PRs from GitHub (open state, assignees, labels, comments, reviews, checks, activity)
 * 2. Overdue tasks (strictly when a reliable deadline exists: milestone due date or work item estimate)
 * 3. Stalled tasks (inactivity thresholds > 7 days or > 14 days without comment/update)
 * 4. Blocked tasks & dependency risks (via schedule-engine and milestone health)
 * 5. Developer workload concerns (via assignment/capacity data)
 * 6. Pull requests awaiting review or failing CI checks
 * 7. Actionable recommendations & risk explanations with direct GitHub URLs
 */

export function calculateProjectHealth({
  project,
  githubIssues = [],
  githubPulls = [],
  milestones = [],
  scheduleItems = [],
  developerProfiles = [],
  evidenceByUser = {},
  options = { stalledThresholdDays: 7 }
}) {
  const now = Date.now();
  const stalledMs = (options.stalledThresholdDays || 7) * 24 * 60 * 60 * 1000;

  const criticalIssues = [];
  const riskExplanations = [];
  const recommendedActions = [];
  const workloadConcerns = [];
  const prConcerns = [];
  const dependencyRisks = [];

  let overdueCount = 0;
  let stalledCount = 0;
  let blockedCount = 0;

  // Map milestones by title or number
  const milestoneMap = new Map();
  for (const m of milestones) {
    if (m.title) milestoneMap.set(m.title.toLowerCase(), m);
    if (m.milestone_id) milestoneMap.set(m.milestone_id.toLowerCase(), m);
  }

  // 1. Analyze GitHub Issues (ignoring Pull Requests in the issues endpoint)
  const pureIssues = githubIssues.filter(item => !item.pull_request);

  for (const issue of pureIssues) {
    const isClosed = issue.state === 'closed';
    if (isClosed) continue;

    const issueUrl = issue.html_url || `https://github.com/${project?.owner}/${project?.repository}/issues/${issue.number}`;
    const updatedAt = issue.updated_at ? new Date(issue.updated_at).getTime() : null;
    const createdAt = issue.created_at ? new Date(issue.created_at).getTime() : null;
    const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name || '').toLowerCase());
    const isExplicitlyBlocked = labels.some(l => l.includes('blocked') || l.includes('impediment') || l.includes('waiting'));

    // Check overdue: only when reliable deadline exists
    let deadline = null;
    let deadlineSource = null;

    if (issue.milestone && issue.milestone.due_on) {
      deadline = new Date(issue.milestone.due_on).getTime();
      deadlineSource = `milestone "${issue.milestone.title}"`;
    }

    if (deadline && !isNaN(deadline)) {
      if (now > deadline) {
        overdueCount++;
        criticalIssues.push({
          type: 'overdue_issue',
          number: issue.number,
          title: issue.title,
          url: issueUrl,
          severity: 'high',
          deadline: new Date(deadline).toISOString(),
          deadlineSource,
          explanation: `Issue #${issue.number} "${issue.title}" is overdue past ${deadlineSource} deadline (${new Date(deadline).toLocaleDateString()}).`
        });
        recommendedActions.push({
          issueNumber: issue.number,
          type: 'reschedule_or_triage',
          title: `Triage overdue issue #${issue.number}`,
          url: issueUrl,
          reason: `Work missed target date on ${deadlineSource}. Check scope or reassign.`
        });
      }
    }

    // Check stalled tasks: inactive for > threshold
    const lastActive = updatedAt || createdAt;
    if (lastActive && (now - lastActive > stalledMs)) {
      stalledCount++;
      const daysInactive = Math.floor((now - lastActive) / (24 * 60 * 60 * 1000));
      criticalIssues.push({
        type: 'stalled_issue',
        number: issue.number,
        title: issue.title,
        url: issueUrl,
        severity: daysInactive >= 14 ? 'high' : 'medium',
        daysInactive,
        explanation: `Issue #${issue.number} has been inactive for ${daysInactive} days without updates.`
      });
      recommendedActions.push({
        issueNumber: issue.number,
        type: 'request_status_update',
        title: `Ping assignee for status on #${issue.number}`,
        url: issueUrl,
        reason: `No activity observed in ${daysInactive} days.`
      });
    }

    // Check blocked state
    if (isExplicitlyBlocked) {
      blockedCount++;
      criticalIssues.push({
        type: 'blocked_issue',
        number: issue.number,
        title: issue.title,
        url: issueUrl,
        severity: 'high',
        explanation: `Issue #${issue.number} is marked with a blocking label: "${labels.find(l => l.includes('blocked') || l.includes('waiting'))}".`
      });
      recommendedActions.push({
        issueNumber: issue.number,
        type: 'unblock_dependency',
        title: `Resolve blocker on #${issue.number}`,
        url: issueUrl,
        reason: `Task is blocked by external dependencies.`
      });
    }
  }

  // 2. Dependency & Milestone Risks from Schedule Engine
  for (const s of scheduleItems) {
    if (s.is_critical && s.slack === 0) {
      dependencyRisks.push({
        workItemId: s.work_item_id,
        title: s.title || `Work item ${s.item_id || s.work_item_id}`,
        slack: s.slack,
        explanation: `Work item is on the critical path with zero slack. Any delay will directly postpone project delivery.`
      });
    }
  }

  // 3. Developer Workload Concerns (via available assignment & profile data)
  for (const profile of developerProfiles) {
    const username = (profile.github_username || '').toLowerCase();
    const maxTasks = Number(profile.max_concurrent_tasks) || 3;
    const weeklyHours = Number(profile.weekly_capacity_hours) || 40;
    const evidence = evidenceByUser[username];
    const openAssigned = evidence ? Number(evidence.openAssignedIssuesCount) || 0 : 0;

    if (!profile.is_available) {
      workloadConcerns.push({
        username: profile.github_username,
        type: 'unavailable',
        severity: 'medium',
        explanation: `@${profile.github_username} is currently marked as unavailable/away, but may hold assigned tasks.`
      });
    } else if (openAssigned > maxTasks) {
      workloadConcerns.push({
        username: profile.github_username,
        type: 'overallocated',
        severity: 'high',
        openIssuesCount: openAssigned,
        capacity: maxTasks,
        explanation: `@${profile.github_username} has ${openAssigned} open tasks, exceeding declared concurrent capacity of ${maxTasks}.`
      });
      recommendedActions.push({
        type: 'rebalance_workload',
        title: `Rebalance tasks from @${profile.github_username}`,
        url: `https://github.com/${project?.owner}/${project?.repository}/issues?q=is%3Aopen+assignee%3A${profile.github_username}`,
        reason: `@${profile.github_username} is overallocated (${openAssigned}/${maxTasks} tasks).`
      });
    }
  }

  // 4. Pull Requests awaiting review or failing CI checks
  for (const pr of githubPulls) {
    if (pr.state === 'closed') continue;
    const prUrl = pr.html_url || `https://github.com/${project?.owner}/${project?.repository}/pull/${pr.number}`;
    const prUpdated = pr.updated_at ? new Date(pr.updated_at).getTime() : null;
    const isDraft = Boolean(pr.draft);

    if (isDraft) continue;

    // Awaiting review
    const requestedReviewersCount = (pr.requested_reviewers || []).length;
    if (requestedReviewersCount > 0) {
      prConcerns.push({
        number: pr.number,
        title: pr.title,
        url: prUrl,
        type: 'awaiting_review',
        severity: 'medium',
        reviewers: pr.requested_reviewers.map(r => r.login),
        explanation: `PR #${pr.number} is awaiting review from ${pr.requested_reviewers.map(r => '@' + r.login).join(', ')}.`
      });
      recommendedActions.push({
        prNumber: pr.number,
        type: 'remind_reviewers',
        title: `Review PR #${pr.number} (${pr.title})`,
        url: prUrl,
        reason: `Awaiting peer review.`
      });
    }

    // CI checks / review states attached to PR object if available
    if (pr.ciStatus && (pr.ciStatus === 'failure' || pr.ciStatus === 'error')) {
      prConcerns.push({
        number: pr.number,
        title: pr.title,
        url: prUrl,
        type: 'ci_failed',
        severity: 'high',
        explanation: `PR #${pr.number} has failing CI checks (${pr.ciStatus}).`
      });
      recommendedActions.push({
        prNumber: pr.number,
        type: 'fix_ci',
        title: `Investigate CI failure on PR #${pr.number}`,
        url: prUrl,
        reason: `Automated test/build checks failed.`
      });
    }
  }

  // Synthesize Overall Status
  let overallStatus = 'healthy'; // 'healthy', 'needs_attention', 'at_risk'
  if (overdueCount > 0 || blockedCount > 0 || workloadConcerns.some(w => w.severity === 'high') || prConcerns.some(p => p.severity === 'high')) {
    overallStatus = 'at_risk';
  } else if (stalledCount > 0 || prConcerns.length > 0 || dependencyRisks.length > 0) {
    overallStatus = 'needs_attention';
  }

  // Risk Explanations summary
  if (overdueCount > 0) {
    riskExplanations.push(`${overdueCount} issue(s) are overdue past scheduled milestones.`);
  }
  if (stalledCount > 0) {
    riskExplanations.push(`${stalledCount} task(s) appear stalled with no activity in over ${options.stalledThresholdDays} days.`);
  }
  if (blockedCount > 0) {
    riskExplanations.push(`${blockedCount} task(s) are blocked by external dependencies.`);
  }
  if (dependencyRisks.length > 0) {
    riskExplanations.push(`${dependencyRisks.length} item(s) are on the critical path with zero schedule buffer.`);
  }
  if (workloadConcerns.length > 0) {
    riskExplanations.push(`${workloadConcerns.length} developer workload concern(s) detected.`);
  }
  if (prConcerns.length > 0) {
    riskExplanations.push(`${prConcerns.length} pull request(s) require attention (review or CI).`);
  }
  if (riskExplanations.length === 0) {
    riskExplanations.push('All tracked tasks, pull requests, and assignments are progressing within expected bounds.');
  }

  return {
    overallStatus,
    summary: {
      totalOpenIssues: pureIssues.length,
      totalOpenPulls: githubPulls.length,
      overdueCount,
      stalledCount,
      blockedCount,
      workloadConcernsCount: workloadConcerns.length,
      prConcernsCount: prConcerns.length,
      dependencyRisksCount: dependencyRisks.length
    },
    criticalIssues,
    prConcerns,
    workloadConcerns,
    dependencyRisks,
    riskExplanations,
    recommendedActions,
    evaluatedAt: new Date().toISOString()
  };
}

export default {
  calculateProjectHealth
};
