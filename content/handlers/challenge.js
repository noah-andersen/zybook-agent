// --- ZyBook Agent - Challenge Dispatcher ---
// Slim entry point that detects the challenge sub-type and delegates to:
//   challenge-parsons.js   -> Type C: Parsons problems (drag-and-drop)
//   challenge-coding.js    -> Type A: Code-writing / Type B: Output prediction
// Shared helpers live in challenge-shared.js.

(function () {
  'use strict';

  const Z = window.ZyAgent;

  Z.handleChallenge = async function (activity, settings) {
    const el = activity.element;

    // Detect sub-type
    const hasProgression    = el.querySelector('.zyante-progression-start-button, .zyante-progression-check-button');
    const hasAceEditor      = el.querySelector('.ace_editor');
    const hasOutputTextarea  = el.querySelector('textarea.console');
    const hasParsons        = el.querySelector('.two-reorderable-lists, .parsons-coding-pa');

    if (hasParsons) {
      // Type C: Parsons Problem (drag-and-drop code ordering)
      console.log('[ZyAgent] Challenge sub-type: Parsons Problem (drag-and-drop)');
      return Z._challenge_handleParsons(activity, settings);

    } else if (hasProgression && hasOutputTextarea && !hasAceEditor) {
      // Type B: Output prediction / trace-the-code
      console.log('[ZyAgent] Challenge sub-type: Output Prediction (zyante-progression)');
      return Z._challenge_handleOutputPrediction(activity, settings);

    } else if (hasAceEditor) {
      // Type A: ACE editor code-writing
      console.log('[ZyAgent] Challenge sub-type: Code Writing (ACE editor)');
      return Z._challenge_handleCodeWriting(activity, settings);

    } else if (hasProgression) {
      // Progression without ACE editor and without textarea
      console.log('[ZyAgent] Challenge sub-type: Progression (unknown format, trying output prediction)');
      return Z._challenge_handleOutputPrediction(activity, settings);

    } else {
      Z.sendProgress(0, 0, `Challenge "${activity.title}": unknown sub-type - skipping`, 'error');
      console.error('[ZyAgent] Unknown challenge sub-type:', el.innerHTML.substring(0, 500));
    }
  };

})();
