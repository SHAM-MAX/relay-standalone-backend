/**
 * Requirements-to-Delivery Traceability Intelligence Engine
 * Correlates: Requirements -> Epics/Tasks (Work Items) -> GitHub Issues -> Pull Requests -> Test Evidence -> Delivery Status
 */

/**
 * Extract Acceptance Criteria list from a Markdown text body.
 * Looks for ## ACCEPTANCE CRITERIA or ## DEFINITION OF DONE sections and list items (- [ ] / - [x] / - / * / 1.)
 */
export function extractAcceptanceCriteria(text) {
  if (!text || typeof text !== 'string') return [];
  
  const criteria = [];
  const lines = text.split(/\r?\n/);
  let inCriteriaSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check for section headers
    if (/^#+\s+(?:acceptance\s+criteria|definition\s+of\s+done)/i.test(line)) {
      inCriteriaSection = true;
      continue;
    } else if (inCriteriaSection && /^#+\s+/.test(line)) {
      // Reached next section header
      break;
    }

    if (inCriteriaSection && line) {
      // Check for bullet items or checklist items
      const checkMatch = line.match(/^[-*]\s*\[([ xX])\]\s*(.+)$/);
      if (checkMatch) {
        criteria.push({
          text: checkMatch[2].trim(),
          completed: checkMatch[1].toLowerCase() === 'x'
        });
      } else {
        const bulletMatch = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
        if (bulletMatch) {
          criteria.push({
            text: bulletMatch[1].trim(),
            completed: false
          });
        }
      }
    }
  }

  // Fallback: if no explicit section header found, search for bullet list items with "acceptance" in surrounding context
  return criteria;
}

/**
 * Extract referenced GitHub issue numbers from PR body and title.
 * Handles patterns like "fixes #12", "closes #45", "resolve #3", or simple "#12"
 */
export function extractReferencedIssueNumbers(pr) {
  const numbers = new Set();
  const text = `${pr.title || ''}\n${pr.body || ''}\n${pr.head?.ref || ''}`;

  // Closing keyword patterns: fixes #12, closes #12, resolves #12
  const closingRegex = /(?:close[sd]?|fixe?[sd]?|resolve[sd]?)\s+#(\d+)/gi;
  let match;
  while ((match = closingRegex.exec(text)) !== null) {
    numbers.add(parseInt(match[1], 10));
  }

  // Generic issue reference patterns: #12
  const genericRegex = /#(\d+)/g;
  while ((match = genericRegex.exec(text)) !== null) {
    numbers.add(parseInt(match[1], 10));
  }

  return Array.from(numbers);
}

/**
 * Evaluate CI / Test Verification Status from commit status / check-runs.
 * Distinguishes verified completion from an issue merely being closed or a PR being merged.
 */
export function evaluateTestEvidence(ciStatus, prState, prMerged) {
  // ciStatus may be 'success', 'failure', 'pending', 'missing'
  const normalizedStatus = (ciStatus || 'missing').toLowerCase();

  let verificationState = 'unverified';
  let verificationLabel = 'No test/CI evidence';

  if (normalizedStatus === 'success') {
    verificationState = 'verified';
    verificationLabel = 'CI / Test verification passed';
  } else if (normalizedStatus === 'failure' || normalizedStatus === 'error') {
    verificationState = 'failed';
    verificationLabel = 'CI / Test checks failed';
  } else if (normalizedStatus === 'pending') {
    verificationState = 'pending';
    verificationLabel = 'CI / Test checks in progress';
  }

  return {
    verificationState,
    verificationLabel,
    ciStatus: normalizedStatus,
    prMerged: !!prMerged,
    prState: prState || 'unknown'
  };
}

/**
 * Compute delivery status for a requirement based on its work items, issues, PRs, and test evidence.
 */
export function computeRequirementDeliveryStatus(req, workItems = []) {
  if (!workItems || workItems.length === 0) {
    return {
      status: 'missing_work_items',
      label: 'Missing Work Items / Issues',
      badgeClass: 'gap',
      isComplete: false,
      isVerified: false
    };
  }

  const itemsWithIssues = workItems.filter(wi => wi.githubIssueNumber || wi.github_issue_number);
  if (itemsWithIssues.length === 0) {
    return {
      status: 'missing_issues',
      label: 'Issues Not Published',
      badgeClass: 'gap',
      isComplete: false,
      isVerified: false
    };
  }

  // Check if any work item has PRs
  let totalPrCount = 0;
  let allPrsMerged = true;
  let hasPrs = false;
  let allVerified = true;
  let anyPrFailed = false;
  let allIssuesClosed = true;

  for (const item of workItems) {
    const issueState = (item.githubIssue?.state || '').toLowerCase();
    if (issueState !== 'closed') {
      allIssuesClosed = false;
    }

    const prs = item.pullRequests || [];
    if (prs.length > 0) {
      hasPrs = true;
      totalPrCount += prs.length;
      for (const pr of prs) {
        if (!pr.merged_at && pr.state !== 'closed') {
          allPrsMerged = false;
        }
        if (pr.evidence?.verificationState === 'failed') {
          anyPrFailed = true;
        }
        if (pr.evidence?.verificationState !== 'verified') {
          allVerified = false;
        }
      }
    } else {
      allPrsMerged = false;
      allVerified = false;
    }
  }

  if (!hasPrs) {
    return {
      status: 'missing_prs',
      label: 'No Linked PRs',
      badgeClass: 'warning',
      isComplete: false,
      isVerified: false
    };
  }

  if (anyPrFailed) {
    return {
      status: 'checks_failed',
      label: 'CI Checks Failed',
      badgeClass: 'danger',
      isComplete: false,
      isVerified: false
    };
  }

  if (allPrsMerged && allVerified) {
    return {
      status: 'verified_complete',
      label: 'Verified Complete',
      badgeClass: 'verified',
      isComplete: true,
      isVerified: true
    };
  }

  if (allPrsMerged || (allIssuesClosed && hasPrs)) {
    return {
      status: 'delivered_unverified',
      label: 'Delivered (Unverified)',
      badgeClass: 'unverified',
      isComplete: true,
      isVerified: false
    };
  }

  return {
    status: 'in_progress',
    label: 'In Progress',
    badgeClass: 'in_progress',
    isComplete: false,
    isVerified: false
  };
}

/**
 * Build the full Traceability Matrix and Gap Analysis.
 *
 * @param {Array} rawTraceability - Reqs with joined workItems from traceabilityStore.getTraceability(projectId)
 * @param {Array} githubIssues - Live GitHub issues fetched from repo
 * @param {Array} githubPulls - Live GitHub pull requests fetched from repo
 */
export function buildTraceabilityMatrix(rawTraceability = [], githubIssues = [], githubPulls = []) {
  const issuesByNumber = new Map();
  for (const issue of githubIssues) {
    if (issue && typeof issue.number === 'number') {
      issuesByNumber.set(issue.number, issue);
    }
  }

  // Index pull requests by linked issue numbers
  const prsByIssueNumber = new Map();
  const linkedPrIds = new Set();

  for (const pr of githubPulls) {
    const referencedIssues = extractReferencedIssueNumbers(pr);
    pr.linkedIssueNumbers = referencedIssues;

    const evidence = evaluateTestEvidence(pr.ciStatus, pr.state, pr.merged_at);
    pr.evidence = evidence;

    for (const num of referencedIssues) {
      if (!prsByIssueNumber.has(num)) {
        prsByIssueNumber.set(num, []);
      }
      prsByIssueNumber.get(num).push(pr);
      linkedPrIds.add(pr.id || pr.number);
    }
  }

  const linkedWorkItemIssueNumbers = new Set();
  const enrichedRequirements = [];

  // Gaps tracking
  const requirementsWithoutIssues = [];
  const issuesWithoutPrs = [];
  const prsWithoutRequirements = [];

  for (const req of rawTraceability) {
    const reqCriteria = extractAcceptanceCriteria(req.description);
    const enrichedWorkItems = [];

    const workItems = req.workItems || [];
    if (workItems.length === 0) {
      requirementsWithoutIssues.push({
        reqId: req.req_id,
        title: req.title,
        reason: 'Requirement has no tasks or work items created.'
      });
    }

    for (const item of workItems) {
      const issueNum = item.github_issue_number ? parseInt(item.github_issue_number, 10) : null;
      let ghIssue = null;
      let linkedPulls = [];

      if (issueNum) {
        linkedWorkItemIssueNumbers.add(issueNum);
        ghIssue = issuesByNumber.get(issueNum) || null;
        linkedPulls = prsByIssueNumber.get(issueNum) || [];
      }

      // Check item acceptance criteria
      const itemCriteria = extractAcceptanceCriteria(item.description);
      const combinedCriteria = [...reqCriteria, ...itemCriteria];

      if (!issueNum) {
        requirementsWithoutIssues.push({
          reqId: req.req_id,
          itemId: item.item_id,
          title: item.title,
          reason: 'Work item has not been published to a GitHub issue.'
        });
      } else if (linkedPulls.length === 0) {
        issuesWithoutPrs.push({
          reqId: req.req_id,
          itemId: item.item_id,
          issueNumber: issueNum,
          title: item.title,
          issueUrl: item.github_issue_url,
          reason: `Issue #${issueNum} has no linked Pull Requests.`
        });
      }

      enrichedWorkItems.push({
        id: item.id,
        itemId: item.item_id,
        type: item.type,
        title: item.title,
        status: item.status,
        description: item.description,
        githubIssueNumber: issueNum,
        githubIssueUrl: item.github_issue_url,
        githubIssue: ghIssue ? {
          number: ghIssue.number,
          title: ghIssue.title,
          state: ghIssue.state,
          html_url: ghIssue.html_url,
          assignees: (ghIssue.assignees || []).map(a => a.login)
        } : null,
        pullRequests: linkedPulls.map(pr => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          html_url: pr.html_url,
          merged_at: pr.merged_at || null,
          headSha: pr.head?.sha || null,
          evidence: pr.evidence
        })),
        acceptanceCriteria: combinedCriteria
      });
    }

    const deliveryStatus = computeRequirementDeliveryStatus(req, enrichedWorkItems);

    enrichedRequirements.push({
      id: req.id,
      reqId: req.req_id,
      title: req.title,
      description: req.description,
      status: req.status,
      workItems: enrichedWorkItems,
      acceptanceCriteria: reqCriteria,
      deliveryStatus
    });
  }

  // Identify PRs without any linked requirements/issues
  for (const pr of githubPulls) {
    const prIdentifier = pr.id || pr.number;
    let isLinkedToReq = false;

    const refs = pr.linkedIssueNumbers || [];
    for (const ref of refs) {
      if (linkedWorkItemIssueNumbers.has(ref)) {
        isLinkedToReq = true;
        break;
      }
    }

    if (!isLinkedToReq) {
      prsWithoutRequirements.push({
        prNumber: pr.number,
        title: pr.title,
        html_url: pr.html_url,
        state: pr.state,
        referencedIssues: refs,
        reason: refs.length === 0 
          ? `PR #${pr.number} does not mention any issue or requirement in title/body.`
          : `PR #${pr.number} references issue(s) #${refs.join(', #')}, but none are linked to a registered Requirement.`
      });
    }
  }

  // Summary statistics: each requirement is counted in verified, delivered_unverified, or in_progress (including active work lacking PRs/checks)
  const totalRequirements = enrichedRequirements.length;
  const verifiedRequirementsCount = enrichedRequirements.filter(r => r.deliveryStatus.isVerified).length;
  const deliveredUnverifiedCount = enrichedRequirements.filter(r => r.deliveryStatus.status === 'delivered_unverified').length;
  const inProgressCount = enrichedRequirements.filter(r => 
    !r.deliveryStatus.isComplete && r.deliveryStatus.status !== 'missing_work_items'
  ).length;
  const gapCount = requirementsWithoutIssues.length + issuesWithoutPrs.length + prsWithoutRequirements.length;

  return {
    requirements: enrichedRequirements,
    gaps: {
      requirementsWithoutIssues,
      issuesWithoutPrs,
      prsWithoutRequirements,
      totalGaps: gapCount
    },
    summary: {
      totalRequirements,
      verifiedCount: verifiedRequirementsCount,
      deliveredUnverifiedCount,
      inProgressCount,
      totalGaps: gapCount,
      verificationRate: totalRequirements > 0 ? Math.round((verifiedRequirementsCount / totalRequirements) * 100) : 0
    }
  };
}

export default {
  extractAcceptanceCriteria,
  extractReferencedIssueNumbers,
  evaluateTestEvidence,
  computeRequirementDeliveryStatus,
  buildTraceabilityMatrix
};
