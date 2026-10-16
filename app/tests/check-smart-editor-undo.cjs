'use strict';
// Formal regression uses actual product code, never the temporary causal experiment.
const assert = require('node:assert/strict');
assert.notEqual(process.env.RETENTION_GUARD_APPEND, '1', 'Temporary append guard is forbidden in formal regression');
process.env.RETENTION_REQUIRE_UNDO = '1';
process.env.RETENTION_COHORTS = 'none';
process.env.RETENTION_PHASE = 'post-fix';
require('./check-smart-editor-retention.cjs');
