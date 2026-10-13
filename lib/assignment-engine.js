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

  const recommendations = candidates.map(candidate => {
    const warnings = [];
    let evidencePoints = 0;
    const maxEvidencePoints = 4;

    // --- 1. Technical Skills & Experience ---
    let skillsScore = 50; // Default neutral if no requirement specified
    const declaredSkills = (candidate.profile?.declared_skills || []).map(s => String(s).toLowerCase().trim());
    
    if (!candidate.profile) {
      warnings.push('No developer profile found; declared skills are missing');
      skillsScore = 20;
    } else {
      evidencePoints += 1;
      if (reqSkills.length > 0) {
        const matches = reqSkills.filter(skill => 
          declaredSkills.some(ds => ds.includes(skill) || skill.includes(ds))
        );
        const matchRatio = matches.length / reqSkills.length;
        skillsScore = Math.round(matchRatio * 100);
      } else {
        // If task has no explicit skills required, look at task title/description keywords vs declared skills
        const textToMatch = `${task.title || ''} ${task.description || ''}`.toLowerCase();
        const matches = declaredSkills.filter(s => textToMatch.includes(s));
        if (matches.length > 0) {
          skillsScore = Math.min(100, 50 + matches.length * 15);
        } else {
          skillsScore = 50;
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

    // Confidence Level: based on available evidence points
    let confidence = 'Low';
    const confidencePct = Math.round((evidencePoints / maxEvidencePoints) * 100);
    if (confidencePct >= 75) confidence = 'High';
    else if (confidencePct >= 50) confidence = 'Medium';

    // Rationale generation
    const rationaleParts = [];
    if (skillsScore >= 70) rationaleParts.push('Strong match with required technical skills');
    else if (skillsScore <= 30) rationaleParts.push('Limited declared skills match');

    if (workloadScore >= 75) rationaleParts.push('Ample workload bandwidth');
    else if (workloadScore <= 35) rationaleParts.push('High open workload');

    if (familiarityScore >= 70) rationaleParts.push('High prior repository familiarity');
    if (isLowRisk && fairnessScore >= 75) rationaleParts.push('Growth opportunity on suitable lower-risk task');
    if (availabilityScore === 0) rationaleParts.push('Currently marked unavailable');

    const rationale = rationaleParts.length > 0 
      ? rationaleParts.join('. ') + '.' 
      : 'Evaluated based on balanced team criteria.';

    return {
      githubUsername: candidate.username,
      githubId: candidate.githubId,
      overallScore: weightedScore,
      confidence,
      confidencePercentage: confidencePct,
      rationale,
      criteria: {
        technicalSkills: {
          score: skillsScore,
          weight: '30%',
          declaredSkills: candidate.profile?.declared_skills || [],
          matchedSkills: reqSkills.filter(s => declaredSkills.some(ds => ds.includes(s) || s.includes(ds)))
        },
        workloadAndEffort: {
          score: workloadScore,
          weight: '25%',
          openAssignedIssues: openIssues,
          maxConcurrentTasks: maxConcurrent
        },
        repositoryFamiliarity: {
          score: familiarityScore,
          weight: '20%',
          recordedContributions: contributions
        },
        availabilityAndDeadlines: {
          score: availabilityScore,
          weight: '15%',
          isAvailable: candidate.profile ? candidate.profile.is_available : null,
          weeklyCapacityHours: candidate.profile ? candidate.profile.weekly_capacity_hours : null
        },
        growthAndFairness: {
          score: fairnessScore,
          weight: '10%',
          appliedForLowRisk: isLowRisk
        }
      },
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
