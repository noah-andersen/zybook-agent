// ─── ZyBook Agent — Content Tool Handler ───
// Handles content-tool-content-resource activities:
//   1. Array games (counting values, finding max) — button-based step-through
//   2. Custom tool simulators (loop simulators, expression evaluators) — form-based input
//   3. Other interactive tools

(function () {
  'use strict';

  const Z = window.ZyAgent;

  // ════════════════════════════════════════════════════════════
  //  DETECT: Is this a form-based simulator (inputs + run button)?
  // ════════════════════════════════════════════════════════════
  function isFormBasedSimulator(el) {
    const customTool = el.querySelector('.custom-tool-container .custom-tool');
    if (!customTool) return false;

    // Must have text input fields inside a code/pre display area
    const inputs = customTool.querySelectorAll('input[type="text"]');
    if (inputs.length < 2) return false;

    // Must have a "run" or "execute" style button
    const runBtn = customTool.querySelector('button.button, button.run-button, button.zb-button');
    if (!runBtn) return false;

    const btnText = runBtn.innerText.toLowerCase();
    if (btnText.includes('run') || btnText.includes('execute') || btnText.includes('evaluate') || btnText.includes('submit')) {
      return true;
    }

    return false;
  }

  // ════════════════════════════════════════════════════════════
  //  HANDLE: Form-based simulator (loop sim, expression eval, etc.)
  // ════════════════════════════════════════════════════════════
  async function handleFormSimulator(activity, settings) {
    const el = activity.element;
    const customTool = el.querySelector('.custom-tool-container .custom-tool');

    // Read instructions
    const instrEl = el.querySelector('.activity-instructions');
    const instructions = instrEl ? instrEl.innerText.trim() : '';

    // Read the code template to understand the structure
    // Replace input elements with markers showing their purpose
    const codeEl = customTool.querySelector('.code, pre');
    let codeTemplate = '';
    if (codeEl) {
      // Build a readable template by walking the DOM nodes
      const walkNodes = (node) => {
        let text = '';
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            text += child.textContent;
          } else if (child.tagName === 'INPUT') {
            // Replace input with a labeled placeholder
            const id = child.id || '';
            let label = '[INPUT]';
            if (/init/i.test(id)) label = '[INIT_VALUE]';
            else if (/relOp/i.test(id)) label = '[REL_OP]';
            else if (/compVal/i.test(id)) label = '[COMP_VALUE]';
            else if (/incOp/i.test(id)) label = '[INC_OP]';
            else if (/incVal/i.test(id)) label = '[INC_VALUE]';
            else if (/op/i.test(id)) label = '[OP]';
            else if (/val/i.test(id)) label = '[VALUE]';
            text += label;
          } else if (child.childNodes && child.childNodes.length > 0) {
            text += walkNodes(child);
          } else {
            text += child.textContent || '';
          }
        }
        return text;
      };
      codeTemplate = walkNodes(codeEl).trim();
    }

    // Identify all input fields with their IDs and context
    const inputs = Array.from(customTool.querySelectorAll('input[type="text"]'));
    const inputInfo = inputs.map((inp, i) => {
      const id = inp.id || '';
      // Try to infer the purpose from the ID or surrounding text
      let purpose = 'unknown';
      if (/init/i.test(id)) purpose = 'initial_value';
      else if (/relOp/i.test(id)) purpose = 'relational_operator';
      else if (/compVal/i.test(id)) purpose = 'comparison_value';
      else if (/incOp/i.test(id)) purpose = 'increment_operator';
      else if (/incVal/i.test(id)) purpose = 'increment_value';
      else if (/op/i.test(id)) purpose = 'operator';
      else if (/val/i.test(id)) purpose = 'value';

      // Get surrounding text for context
      const parent = inp.parentElement;
      const surroundingText = parent ? parent.textContent.trim().substring(0, 80) : '';

      return {
        index: i,
        id: id,
        purpose: purpose,
        placeholder: inp.placeholder || '',
        maxlength: inp.maxLength || '',
        currentValue: inp.value || '',
        surroundingText: surroundingText,
        element: inp
      };
    });

    // Find the run/execute button
    const runBtn = customTool.querySelector('button.button, button.run-button, button.zb-button');
    const runBtnText = runBtn ? runBtn.innerText.trim() : 'Run';

    // Find output display area
    const outputEl = customTool.querySelector('.console, .output, [class*="output"]');

    console.log('[ZyAgent] Form simulator detected:',
      inputs.length, 'input fields,',
      'run button:', runBtnText,
      'instructions length:', instructions.length);

    // ── Ask AI to solve ALL problems at once ──
    const inputFieldsDesc = inputInfo.map(f =>
      `  Field ${f.index}: id="${f.id}" purpose="${f.purpose}" maxlength=${f.maxlength}`
    ).join('\n');

    const messages = [
      {
        role: 'system',
        content: `You are an expert programmer solving a zyBooks interactive simulator activity.

The activity has a form-based code simulator with input fields that you need to fill in.
After filling the inputs, clicking "${runBtnText}" executes the code and shows output.

The activity requires you to solve MULTIPLE problems by entering different values each time.
To complete the activity, you must run the simulator enough times with correct inputs.

CODE TEMPLATE (showing the structure of the simulator):
${codeTemplate}

INPUT FIELDS:
${inputFieldsDesc}

INSTRUCTIONS:
${instructions}

TASK: Determine the correct input values for EACH problem listed in the instructions.

RESPONSE FORMAT — return a JSON array where each element is an object with field values:
[
  {"field_0": "value", "field_1": "value", "field_2": "value", "field_3": "value", "field_4": "value"},
  ...
]

Use "field_N" keys where N is the field index (0-based).

IMPORTANT:
- For relational operators, use: <, <=, >, >=
- For arithmetic operators, use: +, -, *, //, %, **
- Values should be numbers or simple expressions.
- Solve ALL listed problems, one object per problem.
- If a problem says "Come up with your own challenge" or similar, create a simple valid example.
- Return ONLY the JSON array, no explanation.`
      },
      {
        role: 'user',
        content: `Solve all the problems. Return a JSON array of input values for each problem.`
      }
    ];

    let problems;
    try {
      const response = await Z.callAI(settings, messages);
      // Clean the response — extract JSON array
      let cleaned = response
        .replace(/^```(?:json)?\n?/gm, '')
        .replace(/```\s*$/gm, '')
        .trim();

      // Try to extract JSON array if there's surrounding text
      const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        cleaned = arrayMatch[0];
      }

      problems = JSON.parse(cleaned);
      if (!Array.isArray(problems)) {
        problems = [problems];
      }
    } catch (err) {
      console.error('[ZyAgent] Form simulator: AI response parse error:', err);
      Z.sendProgress(0, 0, 'Could not parse AI response for simulator', 'error');
      return;
    }

    console.log('[ZyAgent] Form simulator: AI returned', problems.length, 'problem solutions');

    // ── Iterate through each problem ──
    const totalProblems = problems.length;
    for (let pi = 0; pi < totalProblems; pi++) {
      if (Z.shouldStop) break;

      if (Z.checkCompletion(el)) {
        Z.sendProgress(totalProblems, totalProblems, `Simulator "${activity.title}" completed!`, 'success');
        return;
      }

      const problem = problems[pi];
      Z.sendProgress(pi + 1, totalProblems, `Solving problem ${pi + 1}/${totalProblems}`);

      // Fill in each input field
      for (let fi = 0; fi < inputs.length; fi++) {
        const fieldKey = `field_${fi}`;
        let value = problem[fieldKey];

        // Fallback: try to match by purpose name
        if (value === undefined) {
          const info = inputInfo[fi];
          value = problem[info.purpose] || problem[info.id] || '';
        }

        if (value !== undefined && value !== null) {
          const input = inputs[fi];
          // Clear existing value first
          Z.setNativeValue(input, '');
          await Z.sleep(100);
          Z.setNativeValue(input, String(value));
          await Z.sleep(150);
        }
      }

      await Z.sleep(300);

      // Click the run button (re-query in case DOM updated)
      const currentRunBtn = customTool.querySelector('button.button, button.run-button, button.zb-button');
      if (currentRunBtn && !currentRunBtn.disabled) {
        currentRunBtn.click();
        console.log(`[ZyAgent] Form simulator: clicked "${currentRunBtn.innerText.trim()}" for problem ${pi + 1}`);
      }

      // Wait for output to appear/update
      await Z.sleep(1500);

      // Read output for logging and error detection
      if (outputEl) {
        const output = outputEl.innerText.trim();
        console.log(`[ZyAgent] Form simulator: problem ${pi + 1} output:`, output.substring(0, 200));

        // Check for error indicators (infinite loop, invalid input, etc.)
        const lowerOutput = output.toLowerCase();
        if (lowerOutput.includes('infinite') || lowerOutput.includes('error') ||
            lowerOutput.includes('invalid') || lowerOutput.includes('too many')) {
          console.warn(`[ZyAgent] Form simulator: problem ${pi + 1} produced an error — continuing to next problem`);
        }
      }

      // Check completion after each run
      if (Z.checkCompletion(el)) {
        Z.sendProgress(totalProblems, totalProblems, `Simulator "${activity.title}" completed!`, 'success');
        return;
      }
    }

    // If not yet complete, try a few more creative examples
    // Some simulators require more runs than the listed problems
    if (!Z.checkCompletion(el)) {
      console.log('[ZyAgent] Form simulator: not yet complete after all listed problems — trying extra examples');

      const extraMessages = [
        {
          role: 'system',
          content: `The zyBooks simulator activity is not yet marked complete after running ${totalProblems} problems.
The simulator needs more runs. Generate 3-5 additional valid examples with different values.

CODE TEMPLATE:
${codeTemplate}

INPUT FIELDS:
${inputFieldsDesc}

PREVIOUS PROBLEMS ALREADY SOLVED:
${JSON.stringify(problems)}

Generate NEW, DIFFERENT examples. Return a JSON array.
IMPORTANT: Make sure each example actually produces valid output (the loop should execute at least once and terminate).
Return ONLY the JSON array.`
        },
        {
          role: 'user',
          content: 'Generate more examples.'
        }
      ];

      try {
        const extraResponse = await Z.callAI(settings, extraMessages);
        let cleaned = extraResponse.replace(/^```(?:json)?\n?/gm, '').replace(/```\s*$/gm, '').trim();
        const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
        if (arrayMatch) cleaned = arrayMatch[0];
        const extraProblems = JSON.parse(cleaned);

        for (let pi = 0; pi < extraProblems.length; pi++) {
          if (Z.shouldStop || Z.checkCompletion(el)) break;

          const problem = extraProblems[pi];
          Z.sendProgress(0, 0, `Running extra example ${pi + 1}/${extraProblems.length}`);

          for (let fi = 0; fi < inputs.length; fi++) {
            const fieldKey = `field_${fi}`;
            let value = problem[fieldKey];
            if (value === undefined) {
              const info = inputInfo[fi];
              value = problem[info.purpose] || problem[info.id] || '';
            }
            if (value !== undefined && value !== null) {
              Z.setNativeValue(inputs[fi], '');
              await Z.sleep(100);
              Z.setNativeValue(inputs[fi], String(value));
              await Z.sleep(150);
            }
          }

          await Z.sleep(300);
          const extraRunBtn = customTool.querySelector('button.button, button.run-button, button.zb-button');
          if (extraRunBtn && !extraRunBtn.disabled) extraRunBtn.click();
          await Z.sleep(1500);

          if (Z.checkCompletion(el)) {
            Z.sendProgress(0, 0, `Simulator "${activity.title}" completed!`, 'success');
            return;
          }
        }
      } catch (err) {
        console.warn('[ZyAgent] Form simulator: extra examples failed:', err);
      }
    }

    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Simulator "${activity.title}" completed!`, 'success');
    } else {
      Z.sendProgress(0, 0, `Simulator "${activity.title}" may not be fully complete`, 'warn');
    }
  }

  // ════════════════════════════════════════════════════════════
  //  HANDLE: Array game / button-step content tools
  // ════════════════════════════════════════════════════════════
  async function handleArrayGame(activity, settings) {
    const el = activity.element;

    // Read instructions to understand the task
    const instructionsEl = el.querySelector('.activity-instructions');
    const instructions = instructionsEl ? instructionsEl.innerText.trim() : '';

    // Click Start button
    const startBtn = el.querySelector(
      '.array-games button.zb-button.primary:not([disabled]), ' +
      'button.start-button:not([disabled]), ' +
      'button.zb-button.primary:not([disabled])'
    );
    if (startBtn) {
      startBtn.click();
      await Z.sleep(1200);
      Z.sendProgress(0, 0, 'Started content tool', 'info');
    }

    // Get the initial full context and ask AI for a strategy once
    const initialState = el.innerText.substring(0, 1200);
    const initialButtons = Array.from(
      el.querySelectorAll('.button-container button.zb-button:not([disabled])')
    ).map(b => b.innerText.trim());

    let strategy = null;
    if (initialButtons.length > 0) {
      try {
        const strategyPrompt = [
          {
            role: 'system',
            content: `You are helping with a zyBooks interactive tool activity.
This activity shows values one at a time and you must choose the correct button at each step.
Instructions: "${instructions}"

Analyze the pattern and provide a STRATEGY for which button to press.
The buttons available are: ${initialButtons.join(', ')}

Common patterns:
- "Find max": press "Update max" when value > current max, else "Next value"
- "Count occurrences": press "Count" when value matches target, else "Next value"
- "Find min": press "Update min" when value < current min, else "Next value"
- "Running sum": press "Add to sum" for each value, then "Next value"

Current state:
${initialState}

Respond with a JSON object describing the strategy:
{"pattern": "description", "button_when_condition": "button text", "button_otherwise": "button text", "condition": "description"}
If unsure, respond with: {"pattern": "unknown"}`
          },
          {
            role: 'user',
            content: 'What is the strategy?'
          }
        ];
        const strategyResponse = await Z.callAI(settings, strategyPrompt);
        try {
          const cleaned = strategyResponse.replace(/^```(?:json)?\n?/gm, '').replace(/```$/gm, '').trim();
          strategy = JSON.parse(cleaned);
        } catch (e) {
          strategy = null;
        }
      } catch (e) {
        strategy = null;
      }
    }

    // Iterate through values
    const maxSteps = 50;
    let steps = 0;
    let noButtonStreak = 0;

    while (steps < maxSteps && !Z.shouldStop) {
      // Check completion
      if (Z.checkCompletion(el)) {
        Z.sendProgress(0, 0, `Content tool "${activity.title}" completed!`, 'success');
        return;
      }

      // Find available (non-disabled) action buttons
      const buttons = Array.from(
        el.querySelectorAll('.button-container button.zb-button:not([disabled])')
      ).filter(b => b.offsetParent !== null);

      if (buttons.length === 0) {
        noButtonStreak++;
        if (noButtonStreak > 5) {
          // Check if the Start button reappeared (tool is done, showing replay)
          const replayStart = el.querySelector('.array-games > button.zb-button.primary:not([disabled])');
          if (replayStart && steps > 0) break;
          if (steps > 3) break;
        }
        await Z.sleep(800);
        steps++;
        continue;
      }

      noButtonStreak = 0;
      const buttonTexts = buttons.map(b => b.innerText.trim());

      // If only one button, just click it
      if (buttons.length === 1) {
        buttons[0].click();
        await Z.sleep(800);
        steps++;
        continue;
      }

      // Try strategy-based approach first (avoids AI call per step)
      let clicked = false;

      if (strategy && strategy.pattern !== 'unknown') {
        // Use the strategy to decide — only fall back to AI if strategy is unclear
        const stateText = el.innerText.substring(0, 600);

        // Ask AI with much shorter prompt (strategy-informed)
        const quickPrompt = [
          {
            role: 'system',
            content: `Strategy: ${strategy.pattern}. Condition: ${strategy.condition || 'unknown'}.
Press "${strategy.button_when_condition}" when condition is met, otherwise "${strategy.button_otherwise}".
Respond with ONLY the exact button text. Available: ${buttonTexts.join(', ')}`
          },
          {
            role: 'user',
            content: `Current state: ${stateText.substring(0, 400)}\nWhich button?`
          }
        ];

        try {
          const response = await Z.callAI(settings, quickPrompt);
          const chosenText = response.trim().toLowerCase();
          for (const btn of buttons) {
            const btnText = btn.innerText.trim().toLowerCase();
            if (btnText.includes(chosenText) || chosenText.includes(btnText)) {
              btn.click();
              clicked = true;
              break;
            }
          }
        } catch (err) {
          // Fall through to default
        }
      }

      if (!clicked) {
        // Fallback: click "Next value" or first available
        const nextBtn = buttons.find(b => b.innerText.toLowerCase().includes('next'));
        (nextBtn || buttons[0]).click();
      }

      await Z.sleep(800);
      steps++;
    }

    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Content tool "${activity.title}" completed!`, 'success');
    } else {
      Z.sendProgress(0, 0, `Content tool "${activity.title}" finished ${steps} steps`, 'warn');
    }
  }

  // ════════════════════════════════════════════════════════════
  //  MAIN ENTRY POINT
  // ════════════════════════════════════════════════════════════
  Z.handleContentTool = async function (activity, settings) {
    const el = activity.element;

    if (Z.checkCompletion(el)) {
      Z.sendProgress(0, 0, `Content tool "${activity.title}" already completed, skipping`, 'info');
      return;
    }

    // Detect which sub-type of content tool this is
    if (isFormBasedSimulator(el)) {
      console.log('[ZyAgent] Content tool: detected form-based simulator');
      return handleFormSimulator(activity, settings);
    }

    // Default: array-game style (button step-through)
    console.log('[ZyAgent] Content tool: using array-game handler');
    return handleArrayGame(activity, settings);
  };

})();
