'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./constants');
const { ensureDir, randomId, sha256File, sleep } = require('./util');
const { validateSourceZip, compareSourceZips, writeZipStore } = require('./zip');

class PipelineEngine {
  constructor({ config, home, state, bridge, adapters, evidence, processRunner, logger, privacy }) {
    this.config = config;
    this.home = home;
    this.state = state;
    this.bridge = bridge;
    this.adapters = adapters;
    this.evidence = evidence;
    this.processRunner = processRunner;
    this.logger = logger;
    this.privacy = privacy;
    this.runningTask = null;
    this.resumeResolvers = [];
    bridge.onResult = (id, result) => this.track(() => this.handleResult(id, result));
    bridge.onArtifact = (id, file) => this.track(() => this.handleArtifact(id, file));
  }

  track(factory) {
    const previous = this.runningTask || Promise.resolve();
    const p = previous.then(factory).catch(e => this.fail(e));
    let wrapped;
    wrapped = p.finally(() => { if (this.runningTask === wrapped) this.runningTask = null; });
    this.runningTask = wrapped;
    return wrapped;
  }

  async control(action) {
    switch (action) {
      case 'start':
        if (this.runningTask || !['idle','completed','failed'].includes(this.state.state.phase)) return false;
        this.track(() => this.startFresh());
        return true;
      case 'pause':
        if (this.state.state.phase !== 'running') return false;
        this.state.patchInternal({ pauseRequested:true });
        if (!this.runningTask) this.state.setPhase('paused', 'Paused while waiting for ChatGPT.');
        else this.state.setStage('Pause requested; the current step will finish or safely stop, then the runner will hold.', 'pause_requested');
        return true;
      case 'resume':
        if (this.state.state.phase !== 'paused') return false;
        this.state.patchInternal({ pauseRequested:false, stopRequested:false });
        this.state.setPhase('running', 'Resuming from saved checkpoint.');
        for (const r of this.resumeResolvers.splice(0)) r();
        if (!this.runningTask) {
          this.track(() => this.resumeFromCheckpoint());
        }
        return true;
      case 'stop':
        this.state.patchInternal({ stopRequested:true, pauseRequested:false });
        for (const r of this.resumeResolvers.splice(0)) r();
        await this.processRunner.stopAllOwned();
        if (this.runningTask) await this.runningTask;
        try { this.adapters.rollbackInstalledMod(); } catch (e) { this.logger.error(`Rollback during stop failed: ${e.message}`); }
        this.bridge.completeActive(this.state.state.internal.activeJobId);
        this.state.setQuestion(null, null);
        this.state.setPhase('idle', 'Stopped. Only runner-owned process trees were terminated.');
        for (const r of this.resumeResolvers.splice(0)) r();
        return true;
      case 'retry':
        if (!['failed','idle'].includes(this.state.state.phase)) return false;
        if (this.runningTask) return false;
        this.track(() => this.startFresh());
        return true;
      default: return false;
    }
  }

  async startFresh() {
    const maxAttempts = clampInt(this.config.maxAttempts, 1, 10, C.DEFAULT_MAX_ATTEMPTS);
    this.bridge.completeActive(this.bridge.index.activeJobId);
    this.adapters.runBackup = null;
    this.state.resetForRun(maxAttempts);
    const runId = randomId('run');
    this.state.patchInternal({ runId, checkpoint:'baseline', stopRequested:false, pauseRequested:false });
    try {
      const source = this.config.simulation && !this.config.sourceZip ? this.ensureSimulationSource() : this.config.sourceZip;
      if (!source || !fs.existsSync(source)) throw new Error('Base source ZIP is not configured or does not exist. Run Setup-Runner.ps1 or use simulation mode.');
      const validated = validateSourceZip(source);
      this.state.setCheck('Base source ZIP safety/identity', 'pass');
      this.state.patchInternal({ currentSourceZip:source, currentSourceSha256:validated.sha256 });
      await this.runSourceCycle(source, 0, 'baseline');
    } catch (e) { await this.fail(e); }
  }

  ensureSimulationSource() {
    const file = path.join(this.home, 'simulation-base.zip');
    if (!fs.existsSync(file)) {
      writeZipStore(file, [
        { name:'UnspottableExpanded.csproj', data:'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>netstandard2.1</TargetFramework><AssemblyName>UnspottableExpanded</AssemblyName></PropertyGroup></Project>\n' },
        { name:'src/Plugin.cs', data:'namespace UnspottableExpanded { public class Plugin { } }\n' },
        { name:'tools/Run-H1-Input-SelfTest.ps1', data:"$Game='C:\\\\Simulation'\n" },
        { name:'tools/Run-H2-Gameplay-SelfTest.ps1', data:"$Game='C:\\\\Simulation'\n" }
      ]);
    }
    return file;
  }

  async runSourceCycle(sourceZip, attempt, kind) {
    if (this.stopped()) return;
    this.state.setAttempt(attempt);
    await this.pauseBoundary();
    const runId = this.state.state.internal.runId;
    const workDir = ensureDir(path.join(this.home, 'work', runId, `attempt-${attempt}-${kind}`));
    this.state.patchInternal({ checkpoint:`${kind}:prepare` });
    this.state.setStage(`${kind === 'baseline' ? 'Baseline' : 'Proposal'}: validating and extracting source.`, 'source_prepare');
    const prepared = await this.adapters.prepareSource(sourceZip, workDir);
    this.state.setCheck(`${kind} source extraction`, 'pass');
    await this.pauseBoundary();

    this.state.patchInternal({ checkpoint:`${kind}:build` });
    this.state.setStage(`${kind === 'baseline' ? 'Baseline' : 'Proposal'}: fixed build adapter running.`, 'build_started');
    const build = await this.adapters.build(prepared.projectRoot, workDir);
    this.state.setCheck(`${kind} build`, build.pass ? 'pass' : 'fail');
    await this.pauseBoundary();

    let tests = { pass:false, h1:{pass:false,code:-1,evidenceFiles:[]}, h2:{pass:false,code:-1,evidenceFiles:[]} };
    if (build.pass) {
      this.adapters.ensureGameIdle();
      if (!this.config.simulation) this.adapters.backupInstalledMod();
      this.adapters.deploy(build.dll);
      this.state.setCheck(`${kind} deploy hash`, 'pass');
      this.state.patchInternal({ checkpoint:`${kind}:tests` });
      this.state.setStage(`${kind === 'baseline' ? 'Baseline' : 'Proposal'}: running H1/H2 through fixed adapters.`, 'tests_started');
      tests = await this.adapters.runTests(prepared.projectRoot, workDir);
      await this.pauseBoundary();
      this.state.setCheck(`${kind} H1`, tests.h1.pass ? 'pass' : 'fail');
      this.state.setCheck(`${kind} H2`, tests.h2.status === 'SKIP' ? 'skip' : (tests.h2.pass ? 'pass' : 'fail'));
    } else {
      this.state.setCheck(`${kind} deploy hash`, 'skip');
      this.state.setCheck(`${kind} H1`, 'skip');
      this.state.setCheck(`${kind} H2`, 'skip');
    }

    const allPassed = !!(build.pass && tests.pass);
    this.state.patchInternal({ lastTestsPassed:allPassed, checkpoint:`${kind}:evidence` });
    const bundle = this.evidence.collect({ runId, attempt, sourceSha256:prepared.sha256, build, tests, workDir });
    this.state.patchInternal({ currentEvidenceZip:bundle.path });

    if (!allPassed && !this.config.simulation) {
      try { this.adapters.rollbackInstalledMod(); this.state.setCheck(`${kind} rollback`, 'pass'); }
      catch (e) { this.state.setCheck(`${kind} rollback`, 'fail'); throw e; }
    }

    if (kind !== 'baseline' && allPassed) {
      this.recordKnownGood(sourceZip, build.dll);
      this.state.setPhase('completed', this.config.simulation ? 'Simulation completed; no real game tests were run.' : 'Proposal passed the fixed local build and H1/H2 tests.');
      this.state.addEvent('completed', 'Local tests, not the AI result alone, established completion.');
      this.state.save();
      return;
    }

    const nextAttempt = kind === 'baseline' ? 1 : attempt + 1;
    if (kind !== 'baseline' && !allPassed && attempt >= this.state.state.maxAttempts) {
      this.state.setPhase('failed', `Stopped after ${this.state.state.maxAttempts} bounded proposal attempts; latest local tests did not pass.`);
      return;
    }
    this.state.setAttempt(nextAttempt);
    this.state.patchInternal({ checkpoint:'awaiting_ai' });
    this.queueInspectionJob(sourceZip, bundle.path, nextAttempt, allPassed);
  }

  queueInspectionJob(sourceZip, evidenceZip, attempt, lastPassed, extra = '') {
    const baseSha = sha256File(sourceZip);
    const prompt = [
      this.config.simulation ? 'SIMULATION ONLY: no actual mod/game evidence. Exercise protocol only; do not propose real gameplay changes from this fixture.' : 'Inspect the attached UnspottableExpanded source and privacy-filtered QA evidence.',
      `Base source SHA-256: ${baseSha}`,
      `Automation attempt: ${attempt}/${this.state.state.maxAttempts}.`,
      `Latest fixed local build/H1/H2 overall result: ${lastPassed ? 'PASS' : 'FAIL'}.`,
      'This is the commercial Unity/BepInEx game mod UnspottableExpanded, not the separate browser social-stealth project.',
      'Do not modify runner/, dashboard/, or extension/. Do not add Codex, API calls, another model, OS-wide input, or commands for the runner to execute.',
      'Use the evidence to propose the smallest source change needed. Preserve the process-local QA bridge/input approach.',
      'Return status ready_for_test with a complete source ZIP when code changes are proposed; use needs_input only for a genuine question. A claim of complete is only a proposal and will not override local tests.',
      extra ? `Additional context: ${this.privacy.text(extra).slice(0, 3000)}` : ''
    ].filter(Boolean).join('\n');
    const job = this.bridge.enqueue({
      baseSha256:baseSha,
      prompt,
      attachments:[
        { id:'base_source', name:path.basename(sourceZip).replace(/[^A-Za-z0-9._-]/g,'_'), mime:'application/zip', path:sourceZip },
        { id:'qa_evidence', name:path.basename(evidenceZip).replace(/[^A-Za-z0-9._-]/g,'_'), mime:'application/zip', path:evidenceZip }
      ]
    });
    this.state.setStage(`Waiting for paired ChatGPT inspection job ${job.id}.`, 'awaiting_ai');
  }

  async handleResult(jobId, result) {
    if (this.stopped()) return;
    await this.pauseBoundary();
    this.state.addEvent('ai_result', `ChatGPT result accepted: ${result.status}.`);
    this.state.save();
    if (result.status === 'needs_input') {
      this.state.patchInternal({ pendingReviewType:'ai_question', checkpoint:'needs_input' });
      this.state.setQuestion(jobId, result.question);
      this.state.setPhase('needs_input', 'ChatGPT needs user input before another proposal can be queued.');
      return;
    }
    if (result.artifact) {
      this.state.setStage('ChatGPT result accepted; waiting for the declared source ZIP bytes.', 'awaiting_artifact');
      return;
    }
    if (result.status === 'retest') {
      this.bridge.completeActive(jobId);
      const src = this.state.state.internal.currentSourceZip;
      await this.runSourceCycle(src, this.state.state.attempt, 'proposal');
      return;
    }
    if (result.status === 'complete') {
      if (this.state.state.internal.lastTestsPassed) {
        this.bridge.completeActive(jobId);
        this.state.setPhase('completed', this.config.simulation ? 'Simulation completed; no real game tests were run.' : 'ChatGPT proposed completion and the latest local fixed tests had already passed.');
      } else {
        this.state.patchInternal({ pendingReviewType:'complete_without_proof', checkpoint:'needs_input' });
        this.state.setQuestion(jobId, 'ChatGPT returned complete without a source artifact, but the latest local build/H1/H2 did not all pass. Ask for a concrete fix or answer with guidance for the next inspection.');
        this.state.setPhase('needs_input', 'AI completion is not accepted as proof of passing tests.');
      }
    }
  }

  async handleArtifact(jobId, artifactFile) {
    if (this.stopped()) return;
    await this.pauseBoundary();
    const result = this.bridge.result(jobId);
    const job = this.bridge.loadJob(jobId);
    if (!result || !job) throw new Error('Artifact arrived without durable job/result state.');
    const currentSha = this.state.state.internal.currentSourceSha256;
    if (job.baseSha256 !== currentSha) throw new Error('Stale artifact rejected: active source hash no longer matches the job base hash.');
    this.state.setStage('Validating proposed source ZIP before extraction or build.', 'artifact_validation');
    validateSourceZip(artifactFile);
    const diff = compareSourceZips(this.state.state.internal.currentSourceZip, artifactFile);
    if (diff.protectedChanges.length) {
      const q = `Proposal changes runner-owned paths (${diff.protectedChanges.slice(0,8).join(', ')}). These changes will not be built. Provide guidance to request a new proposal without runner/dashboard/extension changes.`;
      this.state.patchInternal({ pendingCandidate:artifactFile, pendingReviewType:'protected_change', checkpoint:'needs_input' });
      this.state.setQuestion(jobId, q);
      this.state.setPhase('needs_input', 'Proposal rejected from automatic testing because it modifies protected component paths.');
      return;
    }
    if (diff.buildConfigChanges.length) {
      const q = `Proposal changes build/project configuration (${diff.buildConfigChanges.slice(0,8).join(', ')}). Review those files manually. If acceptable, answer exactly APPROVE BUILD CONFIG; otherwise provide rejection guidance.`;
      this.state.patchInternal({ pendingCandidate:artifactFile, pendingReviewType:'build_config_review', checkpoint:'needs_input' });
      this.state.setQuestion(jobId, q);
      this.state.setPhase('needs_input', 'Build/project configuration changed; automatic execution is blocked pending explicit review.');
      return;
    }
    this.bridge.completeActive(jobId);
    await this.testAcceptedCandidate(artifactFile);
  }

  async answer(jobId, answer) {
    if (this.state.state.phase !== 'needs_input' || !this.state.state.question || this.state.state.question.jobId !== jobId) return false;
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 4000) return false;
    const kind = this.state.state.internal.pendingReviewType;
    const safeAnswer = this.privacy.text(answer).slice(0, 4000);
    if (kind === 'local_hold') {
      this.state.setQuestion(null, null);
      this.state.patchInternal({ pendingReviewType:null });
      this.state.setPhase('running', 'Retrying the interrupted local step.');
      this.track(() => this.resumeFromCheckpoint());
      return true;
    }
    this.state.setQuestion(null, null);
    this.state.patchInternal({ pendingReviewType:null });
    if (kind === 'build_config_review' && answer.trim() === 'APPROVE BUILD CONFIG') {
      const candidate = this.state.state.internal.pendingCandidate;
      this.state.patchInternal({ pendingCandidate:null });
      this.bridge.completeActive(jobId);
      this.state.setPhase('running', 'Build configuration review approved; continuing with private staged build/test.');
      this.track(() => this.testAcceptedCandidate(candidate));
      return true;
    }
    this.bridge.completeActive(jobId);
    this.state.setPhase('running', 'User input accepted; queuing a follow-up ChatGPT inspection.');
    const src = this.state.state.internal.currentSourceZip;
    const ev = this.state.state.internal.currentEvidenceZip;
    const attempt = this.state.state.attempt;
    this.queueInspectionJob(src, ev, attempt, this.state.state.internal.lastTestsPassed, safeAnswer);
    return true;
  }

  async testAcceptedCandidate(candidate) {
    const attempt = this.state.state.attempt;
    const parsed = validateSourceZip(candidate);
    this.state.patchInternal({ currentSourceZip:candidate, currentSourceSha256:parsed.sha256, pendingCandidate:null });
    await this.runSourceCycle(candidate, attempt, 'proposal');
  }

  recordKnownGood(sourceZip, dll) {
    const dir = ensureDir(path.join(this.home, 'known-good', 'last-passed'));
    fs.copyFileSync(sourceZip, path.join(dir, 'source.zip'));
    if (!this.config.simulation && dll && fs.existsSync(dll)) fs.copyFileSync(dll, path.join(dir, 'UnspottableExpanded.dll'));
    fs.writeFileSync(path.join(dir, 'sha256.txt'), `${sha256File(sourceZip)}\n`, 'utf8');
  }

  async pauseBoundary() {
    if (this.stopped()) throw stopError();
    if (!this.state.state.internal.pauseRequested) return;
    this.state.setPhase('paused', 'Paused at a safe step boundary.');
    await new Promise(resolve => this.resumeResolvers.push(resolve));
    if (this.stopped()) throw stopError();
  }

  async resumeFromCheckpoint() {
    const cp = this.state.state.internal.checkpoint;
    if (cp === 'awaiting_ai' || cp === 'needs_input') {
      const job = this.bridge.activeJob();
      if (!job) throw new Error('Saved bridge job is unavailable; stop and start a fresh run.');
      const result = this.bridge.result(job.id);
      const artifact = this.bridge.jobFile(job.id, 'artifact.zip');
      const accepted = this.bridge.jobFile(job.id, 'artifact-accepted.json');
      if (result && result.artifact && fs.existsSync(artifact) && fs.existsSync(accepted)) {
        await this.handleArtifact(job.id, artifact);
      } else if (result) {
        await this.handleResult(job.id, result);
      } else this.state.setStage('Await ChatGPT: recovered existing inspection job.', 'recovered_wait');
      return;
    }
    const src = this.state.state.internal.currentSourceZip;
    if (!src || !fs.existsSync(src)) throw new Error('Cannot resume: saved source ZIP is unavailable.');
    await this.runSourceCycle(src, this.state.state.attempt, this.state.state.attempt === 0 ? 'baseline' : 'proposal');
  }

  stopped() { return !!this.state.state.internal.stopRequested || this.state.state.phase === 'idle'; }

  async fail(err) {
    if ((err && err.__uqaStop) || this.stopped()) return;
    this.logger.error(`Runner pipeline failed: ${err.message}`);
    if (err && err.userHold) {
      this.state.patchInternal({ pendingReviewType:'local_hold' });
      this.state.setQuestion(this.state.state.internal.activeJobId || 'local', err.message);
      this.state.setPhase('needs_input', err.message);
      return;
    }
    try { if (!this.config.simulation) this.adapters.rollbackInstalledMod(); } catch (rollbackErr) { this.logger.error(`Rollback after failure also failed: ${rollbackErr.message}`); }
    this.state.setPhase('failed', this.privacy.text(err.message));
  }
}

function clampInt(v, min, max, fallback) { const n = Number(v); return Number.isInteger(n) ? Math.max(min, Math.min(max,n)) : fallback; }
function stopError() { const e = new Error('Stopped'); e.__uqaStop = true; return e; }
module.exports = { PipelineEngine };
