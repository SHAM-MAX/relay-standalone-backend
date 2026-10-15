/**
 * PM Reports & Delivery Forecasting Intelligence Engine
 * 
 * Synthesizes:
 * 1. Project Status Report (Open/completed issues, overdue, stalled, delivery gaps, risks)
 * 2. Sprint & Milestone Report (Milestone completion %, outstanding work, blocked items, milestones at risk)
 * 3. Delivery Forecast (Critical-path duration, target vs estimated completion dates, confidence level & assumptions; NEVER invents exact dates without evidence)
 * 4. Team Workload Summary (Current assignments, declared capacity vs workload, overload alerts; never infers availability from activity alone)
 * 5. Stakeholder Update (Editable daily/weekly draft with progress, achievements, risks, delays, decisions needed)
 */

export function generatePmReports({
  project,
  githubIssues = [],
  githubPulls = [],
  milestones = [],
  scheduleItems = [],
  developerProfiles = [],
  evidenceByUser = {},
  healthAnalysis = null,
  traceabilityMatrix = null,
  risks = [],
  changeRequests = []
}) {
  const now = Date.now();

  // Filter pure issues (GitHub issues API includes PRs if pull_request key is present)
  const pureIssues = githubIssues.filter(i => !i.pull_request);
  const openIssues = pureIssues.filter(i => i.state === 'open');
  const closedIssues = pureIssues.filter(i => i.state === 'closed');

  const openPulls = githubPulls.filter(p => p.state === 'open');
  const mergedPulls = githubPulls.filter(p => Boolean(p.merged_at));
  const closedPulls = githubPulls.filter(p => p.state === 'closed' && !p.merged_at);

  // -------------------------------------------------------------
  // 1. PROJECT STATUS REPORT
  // -------------------------------------------------------------
  const totalIssuesCount = pureIssues.length;
  const completionRate = totalIssuesCount > 0 
    ? Math.round((closedIssues.length / totalIssuesCount) * 100) 
    : 0;

  const overdueIssues = (healthAnalysis?.criticalIssues || []).filter(i => i.type === 'overdue_issue');
  const stalledTasks = (healthAnalysis?.criticalIssues || []).filter(i => i.type === 'stalled_issue');
  const blockedTasks = (healthAnalysis?.criticalIssues || []).filter(i => i.type === 'blocked_issue');

  const deliveryGaps = traceabilityMatrix?.gaps || {
    requirementsWithoutIssues: [],
    issuesWithoutPrs: [],
    prsWithoutRequirements: [],
    totalGaps: 0
  };

  const projectStatusReport = {
    overallStatus: healthAnalysis?.overallStatus || 'healthy',
    completionRate,
    metrics: {
      totalIssues: totalIssuesCount,
      openIssues: openIssues.length,
      closedIssues: closedIssues.length,
      openPulls: openPulls.length,
      mergedPulls: mergedPulls.length,
      overdueCount: overdueIssues.length,
      stalledCount: stalledTasks.length,
      blockedCount: blockedTasks.length,
      totalGaps: deliveryGaps.totalGaps || 0,
      openRisksCount: risks.filter(r => ['identified', 'assessed', 'active'].includes(r.status)).length
    },
    overdueIssues: overdueIssues.map(i => ({
      number: i.number,
      title: i.title,
      url: i.url,
      severity: i.severity,
      deadline: i.deadline,
      explanation: i.explanation
    })),
    stalledTasks: stalledTasks.map(i => ({
      number: i.number,
      title: i.title,
      url: i.url,
      severity: i.severity,
      explanation: i.explanation
    })),
    deliveryGapsSummary: {
      totalGaps: deliveryGaps.totalGaps || 0,
      requirementsWithoutIssuesCount: (deliveryGaps.requirementsWithoutIssues || []).length,
      issuesWithoutPrsCount: (deliveryGaps.issuesWithoutPrs || []).length,
      prsWithoutRequirementsCount: (deliveryGaps.prsWithoutRequirements || []).length
    },
    majorRisks: risks
      .filter(r => (Number(r.score) >= 12 || r.status === 'active'))
      .map(r => ({
        id: r.id,
        riskId: r.risk_id,
        title: r.title,
        score: r.score,
        status: r.status,
        mitigation: r.mitigation_strategy
      }))
  };

  // -------------------------------------------------------------
  // 2. SPRINT AND MILESTONE REPORT
  // -------------------------------------------------------------
  const milestoneReports = milestones.map(m => {
    // Find all issues tagged with this milestone
    const mTitleLower = (m.title || '').toLowerCase();
    const mIdLower = (m.milestone_id || '').toLowerCase();

    const taggedIssues = pureIssues.filter(i => {
      const issueMTitle = (i.milestone?.title || '').toLowerCase();
      return issueMTitle === mTitleLower;
    });

    const mTotal = taggedIssues.length;
    const mClosed = taggedIssues.filter(i => i.state === 'closed').length;
    const mOpen = taggedIssues.filter(i => i.state === 'open').length;
    const mRate = mTotal > 0 ? Math.round((mClosed / mTotal) * 100) : 0;

    // Check if milestone has target date
    let isOverdue = false;
    let targetDateStr = m.target_date || null;
    if (targetDateStr) {
      const targetTime = new Date(targetDateStr).getTime();
      if (!isNaN(targetTime) && now > targetTime && mOpen > 0) {
        isOverdue = true;
      }
    }

    // Check blocked issues in milestone
    const blockedInMilestone = taggedIssues.filter(i => {
      const labels = (i.labels || []).map(l => (typeof l === 'string' ? l : l.name || '').toLowerCase());
      return labels.some(l => l.includes('blocked') || l.includes('waiting') || l.includes('impediment'));
    });

    let healthStatus = 'on_track';
    if (isOverdue || blockedInMilestone.length > 0) {
      healthStatus = 'at_risk';
    } else if (mRate < 50 && targetDateStr) {
      healthStatus = 'needs_attention';
    }

    return {
      id: m.id,
      milestoneId: m.milestone_id,
      title: m.title,
      description: m.description,
      targetDate: targetDateStr,
      isOverdue,
      totalIssues: mTotal,
      openIssues: mOpen,
      closedIssues: mClosed,
      completionRate: mRate,
      healthStatus,
      blockedIssues: blockedInMilestone.map(i => ({
        number: i.number,
        title: i.title,
        url: i.html_url
      }))
    };
  });

  // -------------------------------------------------------------
  // 3. DELIVERY FORECAST (Deterministic CPM-based, No Fabricated Dates)
  // -------------------------------------------------------------
  let deliveryForecast = null;

  if (!scheduleItems || scheduleItems.length === 0) {
    deliveryForecast = {
      status: 'insufficient_data',
      confidence: 'low',
      estimatedCompletionDate: null,
      criticalPathDurationDays: null,
      criticalPathItems: [],
      assumptions: [
        'No project work item schedule or dependencies have been calculated.',
        'Estimates require work items with estimated durations and dependency graph in Schedule Engine.'
      ],
      limitations: 'Cannot forecast delivery date without deterministic duration estimates and precedence graph.'
    };
  } else {
    // Critical path items have slack === 0
    const criticalItems = scheduleItems.filter(s => s.is_critical || s.slack === 0);
    const maxEarlyFinish = Math.max(...scheduleItems.map(s => Number(s.early_finish) || 0), 0);

    // Calculate confidence based on data completeness
    const totalItemsCount = scheduleItems.length;
    const hasBaseline = scheduleItems.some(s => s.is_baseline);
    
    // Convert duration (assuming working days) to estimated date from now if working days
    // Add working days (excluding weekends)
    const addWorkingDays = (startDate, days) => {
      let cur = new Date(startDate);
      let added = 0;
      while (added < days) {
        cur.setDate(cur.getDate() + 1);
        const day = cur.getDay();
        if (day !== 0 && day !== 6) { // not Sunday or Saturday
          added++;
        }
      }
      return cur;
    };

    const estimatedDate = addWorkingDays(new Date(), maxEarlyFinish);

    deliveryForecast = {
      status: 'computed',
      confidence: hasBaseline ? 'high' : 'medium',
      estimatedCompletionDate: estimatedDate.toISOString().split('T')[0],
      criticalPathDurationDays: maxEarlyFinish,
      criticalPathItems: criticalItems.map(c => ({
        itemId: c.item_id || c.work_item_id,
        title: c.title || 'Work Item',
        earlyStart: c.early_start,
        earlyFinish: c.early_finish,
        slack: c.slack
      })),
      assumptions: [
        `Forecast is derived from ${totalItemsCount} scheduled work items via Critical Path Method (CPM).`,
        'Assumes standard 5-day working weeks with no scope expansion.',
        'Durations assume single-contributor sequential execution per critical dependency link.'
      ],
      limitations: hasBaseline 
        ? 'Derived against active project baseline.' 
        : 'Based on dynamic schedule estimates; external GitHub issue impediments may delay critical path.'
    };
  }

  // -------------------------------------------------------------
  // 4. TEAM WORKLOAD SUMMARY
  // -------------------------------------------------------------
  const teamWorkload = [];
  const trackedAssignees = new Set();

  for (const profile of developerProfiles) {
    const username = (profile.github_username || '').toLowerCase();
    if (!username) continue;
    trackedAssignees.add(username);

    const userEvidence = evidenceByUser[username] || {
      openAssignedIssuesCount: 0,
      openAssignedIssues: [],
      recentCommitsCount: 0
    };

    const maxConcurrent = Number(profile.max_concurrent_tasks) || 3;
    const capacityHours = Number(profile.weekly_capacity_hours) || 40;
    const openCount = userEvidence.openAssignedIssuesCount;
    const isOverloaded = openCount >= maxConcurrent;

    teamWorkload.push({
      userId: profile.user_id,
      username: profile.github_username,
      declaredSkills: profile.declared_skills || [],
      weeklyCapacityHours: capacityHours,
      maxConcurrentTasks: maxConcurrent,
      isAvailable: Boolean(profile.is_available),
      currentFocus: profile.current_focus || null,
      openAssignedIssuesCount: openCount,
      openAssignedIssues: userEvidence.openAssignedIssues || [],
      isOverloaded,
      workloadStatus: !profile.is_available ? 'unavailable' : isOverloaded ? 'overloaded' : openCount === 0 ? 'available' : 'healthy'
    });
  }

  // Also include any GitHub assignees on open issues that don't yet have an explicit Relay profile
  for (const issue of openIssues) {
    const assignees = issue.assignees || (issue.assignee ? [issue.assignee] : []);
    for (const a of assignees) {
      const uLower = (a.login || '').toLowerCase();
      if (!trackedAssignees.has(uLower)) {
        trackedAssignees.add(uLower);
        const userEvidence = evidenceByUser[uLower] || {
          openAssignedIssuesCount: 1,
          openAssignedIssues: [{ number: issue.number, title: issue.title, isPullRequest: false }]
        };
        teamWorkload.push({
          userId: null,
          username: a.login,
          declaredSkills: [],
          weeklyCapacityHours: null, // Do not infer
          maxConcurrentTasks: null,  // Do not infer
          isAvailable: true,
          currentFocus: null,
          openAssignedIssuesCount: userEvidence.openAssignedIssuesCount,
          openAssignedIssues: userEvidence.openAssignedIssues,
          isOverloaded: false,
          workloadStatus: 'profile_missing',
          notice: 'Declared capacity not registered; availability and capacity cannot be inferred from activity alone.'
        });
      }
    }
  }

  // -------------------------------------------------------------
  // 5. STAKEHOLDER UPDATE (Template text generation)
  // -------------------------------------------------------------
  const todayStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const repoName = `${project?.owner}/${project?.repository}`;

  const topAchievements = closedIssues.slice(0, 5).map(i => `- Completed #${i.number}: ${i.title}`);
  if (topAchievements.length === 0) {
    topAchievements.push('- Work currently in progress across active sprint items.');
  }

  const topRisks = projectStatusReport.majorRisks.map(r => `- [${r.riskId}] ${r.title} (Mitigation: ${r.mitigation || 'Under review'})`);
  if (topRisks.length === 0) {
    topRisks.push('- No critical or high-severity risks blocking delivery.');
  }

  const topDelays = overdueIssues.map(i => `- Delay on #${i.number}: ${i.title} (${i.explanation})`);
  if (topDelays.length === 0) {
    topDelays.push('- No overdue issues currently flagged.');
  }

  const decisionsRequired = (changeRequests.filter(c => c.status === 'under_review')).map(c => 
    `- Pending Change Request ${c.change_id}: ${c.description} (Requester: ${c.requester || 'Team'})`
  );
  if (decisionsRequired.length === 0) {
    decisionsRequired.push('- No pending change requests or escalation decisions required at this time.');
  }

  const draftUpdate = `### Project Status Update: ${repoName} (${todayStr})

**Overall Health:** ${healthStatusLabel(projectStatusReport.overallStatus)} (${completionRate}% closed issues)

#### Key Progress & Achievements
${topAchievements.join('\n')}

#### Delivery Timeline & Forecast
- Active Milestones: ${milestoneReports.length} (${milestoneReports.filter(m => m.healthStatus === 'at_risk').length} at risk)
- Estimated Completion: ${deliveryForecast.estimatedCompletionDate || 'Pending schedule baseline/estimates'}
- Forecast Confidence: ${deliveryForecast.confidence.toUpperCase()}

#### Risks & Impediments
${topRisks.join('\n')}

#### Delays & Critical Items
${topDelays.join('\n')}

#### Decisions & Approvals Required
${decisionsRequired.join('\n')}
`;

  return {
    projectStatusReport,
    milestoneReport: {
      totalMilestones: milestoneReports.length,
      milestonesAtRiskCount: milestoneReports.filter(m => m.healthStatus === 'at_risk').length,
      milestones: milestoneReports
    },
    deliveryForecast,
    teamWorkload: {
      totalMembers: teamWorkload.length,
      overloadedCount: teamWorkload.filter(m => m.isOverloaded).length,
      availableCount: teamWorkload.filter(m => m.workloadStatus === 'available').length,
      members: teamWorkload
    },
    stakeholderUpdate: {
      date: todayStr,
      draftText: draftUpdate
    },
    generatedAt: new Date().toISOString()
  };
}

function healthStatusLabel(status) {
  switch (status) {
    case 'healthy': return 'Healthy';
    case 'needs_attention': return 'Needs Attention';
    case 'at_risk': return 'At Risk';
    default: return 'Active';
  }
}

export default {
  generatePmReports
};
