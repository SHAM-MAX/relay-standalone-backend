import test from 'node:test';
import assert from 'node:assert';
import db from '../lib/db.js';
import { runMigrations } from '../lib/migrator.js';
import projectStore from '../lib/project-store.js';
import riskStore from '../lib/risk-store.js';
import changeStore from '../lib/change-store.js';

test('Phase 4: Risk Management and Change Control', async (t) => {
  await runMigrations();

  let projectId;

  await t.test('1. Setup project', async () => {
    const project = await projectStore.upsertProject({
      owner: 'risk-owner',
      repository: 'risk-repo',
      description: 'Phase 4 test'
    });
    projectId = project.id;
  });

  await t.test('2. Risk Creation and Validation', async () => {
    // Valid risk
    const risk = await riskStore.createRisk(projectId, {
      title: 'Server crash',
      probability: 3,
      impact: 4,
      category: 'Technical',
      mitigationStrategy: 'Add redundancy'
    });

    assert.equal(risk.risk_id, 'RSK-001');
    assert.equal(risk.score, 12);
    assert.equal(risk.status, 'identified');

    // Invalid probability
    await assert.rejects(
      riskStore.createRisk(projectId, {
        title: 'Crash', probability: 6, impact: 4
      }),
      /Probability must be between 1 and 5/
    );

    // Missing fields
    await assert.rejects(
      riskStore.createRisk(projectId, {
        title: 'Crash'
      }),
      /Missing required risk fields/
    );
  });

  await t.test('3. Risk Summary', async () => {
    // Add a high risk
    await riskStore.createRisk(projectId, {
      title: 'Data loss',
      probability: 5,
      impact: 5
    });

    const summary = await riskStore.getProjectRiskSummary(projectId);
    assert.equal(summary.totalRisks, 2);
    assert.equal(summary.openRisks, 2);
    assert.equal(summary.maxScore, 25);
    assert.equal(summary.highRisks, 1);
  });

  let crId;

  await t.test('4. Change Request Creation and Validation', async () => {
    // Valid change request
    const cr = await changeStore.createChangeRequest(projectId, {
      type: 'scope_change',
      description: 'Add dark mode',
      impactScope: 'UI',
      impactSchedule: '1 week',
      impactEffort: 5
    });

    assert.equal(cr.change_id, 'CR-001');
    assert.equal(cr.status, 'draft');
    assert.equal(cr.impact_effort, 5);
    crId = cr.id;

    // Invalid type
    await assert.rejects(
      changeStore.createChangeRequest(projectId, {
        type: 'magic',
        description: 'Do magic'
      }),
      /Invalid change request type/
    );

    // Invalid impact effort
    await assert.rejects(
      changeStore.createChangeRequest(projectId, {
        type: 'scope_change',
        description: 'Dark mode',
        impactScope: 'UI',
        impactSchedule: '1 week',
        impactEffort: -2
      }),
      /Impact effort must be a non-negative integer or null for unknown/
    );
  });

  await t.test('5. Change Request Workflow', async () => {
    // Draft -> Submitted
    let cr = await changeStore.updateChangeRequestStatus(projectId, crId, 'submitted', 'tester');
    assert.equal(cr.status, 'submitted');

    // Submitted -> Under Review
    cr = await changeStore.updateChangeRequestStatus(projectId, crId, 'under_review', 'tester');
    assert.equal(cr.status, 'under_review');

    // Reject invalid transition: Under Review -> Draft
    await assert.rejects(
      changeStore.updateChangeRequestStatus(projectId, crId, 'draft', 'tester'),
      /Invalid status transition/
    );
  });

  await t.test('6. Approval Security and Business Rules', async () => {
    const cr2 = await changeStore.createChangeRequest(projectId, {
      type: 'scope_change',
      description: 'Add dark mode',
      impactScope: 'UI',
      impactSchedule: '1 week',
      impactEffort: 5
    });

    await changeStore.updateChangeRequestStatus(projectId, cr2.id, 'submitted', 'tester');
    await changeStore.updateChangeRequestStatus(projectId, cr2.id, 'under_review', 'tester');

    // Reject missing verifiable identity
    // We mock the API request logic here since we blocked it in api/pm/changes.js:
    // Actually, in the library, approveChangeRequest still exists. But the API rejects.
    // Let's test the store's IDOR check first:
    const p2 = await projectStore.upsertProject({
      owner: 'other-owner',
      repository: 'other-repo',
      description: 'Other project'
    });

    await assert.rejects(
      changeStore.updateChangeRequestStatus(p2.id, cr2.id, 'approved', 'tester'),
      /Change request not found or does not belong to project/
    );

    await assert.rejects(
      changeStore.approveChangeRequest(p2.id, cr2.id, 'admin', 'Notes'),
      /Change request not found or does not belong to project/
    );

    // Business rules for creation
    await assert.rejects(
      changeStore.createChangeRequest(projectId, {
        type: 'defect',
        description: 'Fix bug'
        // Missing affectedFunctionality
      }),
      /Defects must capture affected functionality/
    );

    await assert.rejects(
      changeStore.createChangeRequest(projectId, {
        type: 'scope_change',
        description: 'New feature'
        // Missing impactScope
      }),
      /Scope changes must capture impact analysis/
    );
  });

  await t.test('7. Risk Updates and Status History', async () => {
    const risk = await riskStore.createRisk(projectId, {
      title: 'Server crash',
      probability: 3,
      impact: 4,
      category: 'Technical'
    });

    const updated = await riskStore.updateRiskStatus(projectId, risk.id, 'assessed', 'tester');
    assert.equal(updated.status, 'assessed');

    await assert.rejects(
      riskStore.updateRiskStatus(projectId, risk.id, 'identified', 'tester'),
      /Invalid status transition/
    );

    const p2 = await projectStore.upsertProject({
      owner: 'other-owner2',
      repository: 'other-repo2',
      description: 'Other project'
    });

    await assert.rejects(
      riskStore.updateRiskStatus(p2.id, risk.id, 'closed', 'tester'),
      /Risk not found or does not belong to project/
    );
  });

  await t.test('8. Cleanup', async () => {
    await db.closePool().catch(() => {});
  });
});
