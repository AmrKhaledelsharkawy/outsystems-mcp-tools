/**
 * The suite a fresh clone can run, and the one CI gates on.
 *
 * The include list is **explicit, not a glob**, and that is the point. The repository publishes
 * tests by *fixture provenance* (see `tests/PROVENANCE.md`): a test that reads a capture carrying
 * real module, application, entity or screen names stays local and git-ignored. A glob would
 * silently pull such a test into CI the moment someone wrote one — and on a developer machine,
 * where the local-only files are present, it would pass, so nobody would notice until the name was
 * already public. Naming each file means adding one is a deliberate act with a reviewable diff.
 *
 * Everything listed here runs with **no Service Studio, no osopener, no session token and no
 * network**. A test that needs any of those belongs in the local set.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/accuracy.gate.test.ts",
      "tests/audit.test.ts",
      "tests/config.test.ts",
      "tests/doctor.test.ts",
      "tests/graph.test.ts",
      "tests/graphify.test.ts",
      "tests/layers.test.ts",
      "tests/progress.discover.test.ts",
      "tests/progress.server.test.ts",
      "tests/progress.state.test.ts",
      "tests/query.ergonomics.test.ts",
      "tests/raw.test.ts",
      "tests/readKinds.test.ts",
      "tests/rebuild.test.ts",
      "tests/reextract.test.ts",
      "tests/run.test.ts",
      "tests/scopes.test.ts",
      "tests/servicestudio.client.test.ts",
      "tests/servicestudio.token.test.ts",
      "tests/servicestudio.unwrap.test.ts",
      "tests/smoke.test.ts",
      "tests/status.test.ts",
      "tests/studioLock.test.ts",
      "tests/tools.test.ts"
    ]
  }
});
