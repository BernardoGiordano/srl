'use strict';

// The probe is a host for `run.cjs`, which is where the scenarios are driven. VS Code
// needs an extension to load before it will run an extension test, and this is it.
function activate() {}
function deactivate() {}

module.exports = { activate, deactivate };
