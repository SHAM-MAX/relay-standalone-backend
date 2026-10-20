/**
 * Deterministic scoring engine for Developer Assignment Intelligence (Phase 1).
 *
 * Requirements:
 * 1. Technical skills & relevant experience
 * 2. Current workload & estimated effort
 * 3. Repository/module familiarity
 * 4. Availability, deadlines, & dependencies
 * 5. Growth / fairness for lower-risk tasks
 *
 * Invariants:
 * - Deterministic, pure calculation (same inputs produce exact same outputs).
 * - Never infers availability or skills as fact from GitHub activity alone.
 * - Explains rationale, criteria scores, confidence, and missing-data warnings.
 */

export function calculateAssignmentRecommendations({
  candidates = [],
  task = {
    title: '',
    description: '',
    requiredSkills: [],
    estimatedHours: 8,
    priority: 'Medium', // Low, Medium, High, Critical
    risk: 'Low'         // Low, Medium, High
  }
}) {
  const reqSkills = (task.requiredSkills || []).map(s => String(s).toLowerCase().trim()).filter(Boolean);
  const taskHours = Number(task.estimatedHours) || 8;
  const isLowRisk = String(task.risk).toLowerCase() === 'low' || String(task.priority).toLowerCase() === 'low';

  // Extract technical keywords from title and description (including acceptance criteria)
  // that match declared skills or explicit requirements
  const taskText = `${task.title || ''} ${task.description || ''}`.toLowerCase();

  const recommendations = candidates.map(candidate => {
    const warnings = [];
    let evidencePoints = 0;
    const maxEvidencePoints = 4;

    // --- 1. Technical Skills & Experience ---
    let skillsScore = 50; // Default neutral if no requirement detected
    const candidateSkills = (candidate.profile?.declared_skills || []).map(s => String(s).toLowerCase().trim());
    
    // Find matched declared skills from explicit requiredSkills AND from title/body text
    const matchedFromReqSkills = reqSkills.filter(skill =>
      candidateSkills.some(ds => ds.includes(skill) || skill.includes(ds))
    );
    const matchedFromText = candidateSkills.filter(ds => {
      // Word boundary or containment check for multi-word or special symbols (e.g. node.js, c++, react)
      const escaped = ds.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[^a-z0-9_+#-])${escaped}([^a-z0-9_+#-]|$)`, 'i');
      return regex.test(taskText);
    });

    const allMatchedSkills = Array.from(new Set([...matchedFromReqSkills, ...matchedFromText]));

    if (!candidate.profile) {
      warnings.push('No developer profile found; declared skills are missing');
      skillsScore = 20;
    } else {
      evidencePoints += 1;
      
      // If task explicitly specified required skills (and they are technical, or we found matches)
      if (reqSkills.length > 0) {
        if (matchedFromReqSkills.length > 0) {
          // Matched explicit declared technical requirements
          const ratio = matchedFromReqSkills.length / reqSkills.length;
          skillsScore = Math.round(ratio * 100);
        } else if (matchedFromText.length > 0) {
          // If explicit reqSkills were generic labels (like 'bug', 'task') but title/body had tech matches
          const ratio = Math.min(1, matchedFromText.length / Math.max(1, reqSkills.length));
          skillsScore = Math.round(ratio * 100);
        } else {
          // No match with reqSkills or task text
          // If reqSkills had technical requirements or task had technical content not matching this dev, score 0
          skillsScore = 0;
        }
      } else {
        // No explicit reqSkills provided: extract from title / description / acceptance criteria
        if (matchedFromText.length > 0) {
          // Found declared skills mentioned in ticket title/description/acceptance criteria
          skillsScore = Math.min(100, 50 + matchedFromText.length * 25);
        } else {
          // Genuine check: did the ticket mention any other candidate's skills?
          const anyCandidateSkillsInText = candidates.some(c =>
            (c.profile?.declared_skills || []).some(s => {
              const escaped = s.toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              return new RegExp(`(^|[^a-z0-9_+#-])${escaped}([^a-z0-9_+#-]|$)`, 'i').test(taskText);
            })
          );
          // If other skills were requested/mentioned but this candidate has none of them, low score
          skillsScore = anyCandidateSkillsInText ? 10 : 50;
        }
      }
    }

    // --- 2. Current Workload & Estimated Effort ---
    let workloadScore = 70;
    const openIssues = Number(candidate.githubEvidence?.openAssignedIssuesCount) || 0;
    const maxConcurrent = candidate.profile ? Number(candidate.profile.max_concurrent_tasks) || 3 : 3;
    
    if (candidate.githubEvidence) {
      evidencePoints += 1;
    } else {
      warnings.push('GitHub issue assignment evidence is unavailable');
    }

    if (openIssues >= maxConcurrent) {
      // Overloaded
      const overloadFactor = (openIssues - maxConcurrent + 1);
      workloadScore = Math.max(0, 40 - overloadFactor * 15);
      warnings.push(`Current workload (${openIssues} open assigned items) meets or exceeds capacity (${maxConcurrent})`);
    } else {
      // Healthy capacity
      const capacityRemainingRatio = (maxConcurrent - openIssues) / maxConcurrent;
      workloadScore = Math.round(50 + capacityRemainingRatio * 50);
    }

    // --- 3. Repository / Module Familiarity ---
    let familiarityScore = 40;
    const contributions = Number(candidate.githubEvidence?.recentCommitsCount) || 0;
    if (contributions > 0) {
      evidencePoints += 1;
      if (contributions >= 20) familiarityScore = 100;
      else if (contributions >= 10) familiarityScore = 85;
      else if (contributions >= 5) familiarityScore = 70;
      else familiarityScore = 55;
    } else {
      warnings.push('No repository contributions recorded for this assignee');
      familiarityScore = 30;
    }

    // --- 4. Availability, Deadlines & Capacity ---
    let availabilityScore = 60;
    if (candidate.profile) {
      evidencePoints += 1;
      if (!candidate.profile.is_available) {
        availabilityScore = 0;
        warnings.push('Developer explicitly marked as unavailable');
      } else {
        const weeklyCapacity = Number(candidate.profile.weekly_capacity_hours) || 40;
        if (taskHours > weeklyCapacity) {
          availabilityScore = 30;
          warnings.push(`Task estimated effort (${taskHours}h) exceeds weekly capacity (${weeklyCapacity}h)`);
        } else {
          availabilityScore = Math.min(100, Math.round((weeklyCapacity / 40) * 80 + 20));
        }
      }
    } else {
      warnings.push('Explicit availability schedule not configured');
    }

    // --- 5. Growth & Fairness ---
    let fairnessScore = 50;
    if (isLowRisk) {
      // On lower-risk tasks, favor developers with lower current assigned issues or developing skills to avoid bottlenecking senior devs
      if (openIssues === 0) {
        fairnessScore = 90;
      } else if (openIssues === 1) {
        fairnessScore = 75;
      } else {
        fairnessScore = 40;
      }
    } else {
      fairnessScore = 50;
    }

    // Overall Weighted Score (deterministic)
    // Weights: Skills: 30%, Workload: 25%, Familiarity: 20%, Availability: 15%, Fairness: 10%
    const weightedScore = Math.round(
      (skillsScore * 0.30) +
      (workloadScore * 0.25) +
      (familiarityScore * 0.20) +
      (availabilityScore * 0.15) +
      (fairnessScore * 0.10)
    );

    // Status & Fit Level determination
    const isOverloaded = openIssues >= maxConcurrent;
    const isUnavailable = candidate.profile ? !candidate.profile.is_available : false;
    let fitLevel = 'weak';
    let recommendationStatus = 'weak_fit';
    let isRecommended = false;

    if (isOverloaded) {
      recommendationStatus = 'overloaded';
      fitLevel = 'weak';
      isRecommended = false;
    } else if (isUnavailable) {
      recommendationStatus = 'unavailable';
      fitLevel = 'weak';
      isRecommended = false;
    } else if (weightedScore >= 70 && skillsScore >= 40) {
      recommendationStatus = 'recommended';
      fitLevel = 'strong';
      isRecommended = true;
    } else if (weightedScore >= 50) {
      recommendationStatus = 'moderate';
      fitLevel = 'moderate';
      isRecommended = true;
    } else {
      recommendationStatus = 'weak_fit';
      fitLevel = 'weak';
      isRecommended = false;
    }

    // Confidence Level: based on available evidence completeness (not fit score)
    let confidence = 'Low';
    const confidencePct = Math.round((evidencePoints / maxEvidencePoints) * 100);
    if (confidencePct >= 75) confidence = 'High';
    else if (confidencePct >= 50) confidence = 'Medium';

    // Rationale generation
    const rationaleParts = [];
    if (isOverloaded) {
      rationaleParts.push(`Over capacity (${openIssues} open issues vs ${maxConcurrent} max allowed)`);
    } else if (workloadScore >= 75) {
      rationaleParts.push('Ample workload bandwidth');
    } else if (workloadScore <= 35) {
      rationaleParts.push('High open workload');
    }

    if (skillsScore >= 70) {
      rationaleParts.push(`Strong skills match (${allMatchedSkills.join(', ') || 'matched'})`);
    } else if (skillsScore === 0) {
      rationaleParts.push('No matching declared technical skills');
    } else if (skillsScore <= 30) {
      rationaleParts.push('Limited declared skills match');
    }

    if (familiarityScore >= 70) rationaleParts.push('High prior repository familiarity');
    if (isLowRisk && fairnessScore >= 75) rationaleParts.push('Growth opportunity on suitable lower-risk task');
    if (isUnavailable) rationaleParts.push('Currently marked unavailable');

    const rationale = rationaleParts.length > 0 
      ? rationaleParts.join('. ') + '.' 
      : 'Evaluated based on balanced team criteria.';

    return {
      githubUsername: candidate.username,
      githubId: candidate.githubId,
      overallScore: weightedScore,
      confidence,
      confidencePercentage: confidencePct,
      confidenceMeaning: 'Evidence completeness (data points available)',
      fitLevel,
      recommendationStatus,
      isRecommended,
      isOverloaded,
      rationale,
      criteria: {
        technicalSkills: {
          score: skillsScore,
          weight: '30%',
          declaredSkills: candidate.profile?.declared_skills || [],
          matchedSkills: allMatchedSkills,
          evidenceSource: candidate.profile ? 'Project Developer Profile' : 'Missing (profile required)',
          isConfirmed: Boolean(candidate.profile)
        },
        workloadAndEffort: {
          score: workloadScore,
          weight: '25%',
          openAssignedIssues: openIssues,
          maxConcurrentTasks: maxConcurrent,
          isOverloaded,
          evidenceSource: candidate.githubEvidence ? 'GitHub Issues REST API' : 'Missing (GitHub issues unavailable)',
          isConfirmed: Boolean(candidate.githubEvidence)
        },
        repositoryFamiliarity: {
          score: familiarityScore,
          weight: '20%',
          recordedContributions: contributions,
          evidenceSource: candidate.githubEvidence?.recentCommitsCount ? 'GitHub Contributors REST API' : (candidate.githubEvidence ? 'GitHub Contributors (0 recorded contributions)' : 'Missing (GitHub contributors unavailable)'),
          isConfirmed: Boolean(candidate.githubEvidence)
        },
        availabilityAndDeadlines: {
          score: availabilityScore,
          weight: '15%',
          isAvailable: candidate.profile ? candidate.profile.is_available : null,
          weeklyCapacityHours: candidate.profile ? candidate.profile.weekly_capacity_hours : null,
          evidenceSource: candidate.profile ? 'Project Developer Profile (explicit schedule)' : 'Unknown (profile not configured)',
          isConfirmed: Boolean(candidate.profile)
        },
        growthAndFairness: {
          score: fairnessScore,
          weight: '10%',
          appliedForLowRisk: isLowRisk,
          evidenceSource: 'Workload distribution & task risk evaluation',
          isConfirmed: true
        }
      },
      evidenceSources: [
        ...(candidate.profile ? ['Project Developer Profile'] : []),
        ...(candidate.githubEvidence ? ['GitHub Repository Activity'] : [])
      ],
      missingDataWarnings: warnings
    };
  });

  // Deterministic sorting: highest overall score first; break ties by username ascending
  recommendations.sort((a, b) => {
    if (b.overallScore !== a.overallScore) {
      return b.overallScore - a.overallScore;
    }
    return a.githubUsername.localeCompare(b.githubUsername);
  });

  return recommendations;
}

export default {
  calculateAssignmentRecommendations
};
