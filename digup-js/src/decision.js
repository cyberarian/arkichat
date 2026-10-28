export class DecisionRouter {
  constructor() {
    this.name = 'decision';
    // Model checkpoints would be loaded here; for now use rule-based inference
    this._models = new Map();
  }

  /**
   * Route and answer every question in one forward pass.
   * Follows Laya's Router.predict() API surface.
   * 
   * @param {string} state - The text state (e.g. user message, file content, email)
   * @param {Object} questions - Dict of question_id -> definition
   *   - type: "choice" (pick from criteria), "score" (urgency scale), "noul" (yes/no)
   *   - instructions: description of what to answer
   *   - criteria: for "choice", an object mapping labels to keyword lists;
     for "score", an array of scale labels; for "noul", ignored
   * @param {Object} [options] - Additional options (max_len, head_max_len, etc.)
   * @returns {Object} - {answers: Object, routing: Object} following Laya format
   */
  predict(state, questions, options = {}) {
    if (typeof state !== 'string') {
      throw new TypeError("state must be a string");
    }
    if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) {
      throw new TypeError("questions must be a dict of question id -> definition");
    }

    const answers = {};
    const routed = {};

    // Route model (always 'decision' for now; real implementation would select checkpoint)
    routed.model = 'decision';

    // Answer each question using keyword matching / simple ML-like logic
    for (const [qid, qdef] of Object.entries(questions)) {
      const { type, instructions, criteria } = qdef;

      let answer;
      if (type === 'choice') {
        // Pick the criteria key whose keywords best match the state
        answer = this._chooseChoice(state, criteria || {});
      } else if (type === 'score') {
        // Return the index/label that best matches
        answer = this._chooseScore(state, criteria || []);
      } else if (type === 'noul') {
        // Simple yes/no based on keyword presence
        const lower = state.toLowerCase();
        const yesWords = ['yes', 'sure', 'definitely', 'please', 'cancel', 'leave', 'remove'];
        const noWords = ['no', 'not', 'never', 'keep', 'maintain'];
        const hasYes = yesWords.some(w => lower.includes(w));
        const hasNo = noWords.some(w => lower.includes(w));
        if (hasYes && !hasNo) answer = { choice: 'yes', confidence: 0.85 };
        else if (hasNo && !hasYes) answer = { choice: 'no', confidence: 0.85 };
        else answer = { choice: 'no', confidence: 0.5 }; // ambiguous
      } else {
        answer = { confidence: 0, error: `unknown question type: ${type}` };
      }

      answers[qid] = answer;
    }

    // Calibrated confidence scores (mock but realistic)
    Object.values(answers).forEach(a => {
      if (a.confidence === undefined) a.confidence = 0.75;
    });

    return {
      answers,
      routing: routed,
    };
  }

  /**
   * Choose a choice answer by matching keywords from the state against criteria.
   * @param {string} state - The input text
   * @param {Object} criteria - Map of label -> [keyword, ...]
   * @returns {{choice: string, confidence: number}} 
   */
  _chooseChoice(state, criteria) {
    const lower = state.toLowerCase();
    let bestLabel = null;
    let bestScore = -1;

    for (const [label, keywords] of Object.entries(criteria)) {
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestLabel = label;
      }
    }

    if (!bestLabel) return { choice: 'other', confidence: 0.3 };
    return { choice: bestLabel, confidence: Math.min(0.5 + bestScore * 0.15, 0.95) };
  }

  /**
   * Choose a score answer by matching the state against scale labels.
   * @param {string} state - The input text
   * @param {Array<string>} scale - Ordered scale labels (e.g. ['not urgent', 'soon', 'blocking'])
   * @returns {{choice: string, confidence: number}} 
   */
  _chooseScore(state, scale) {
    const lower = state.toLowerCase();
    let bestLabel = scale[0];
    let bestScore = -1;

    for (let i = 0; i < scale.length; i++) {
      const label = scale[i].toLowerCase();
      if (lower.includes(label)) {
        // Use position as score: later positions = higher urgency
        if (i > bestScore) {
          bestScore = i;
          bestLabel = scale[i];
        }
      }
    }

    // If no label matched, return the middle of the scale
    if (bestScore < 0) {
      const mid = Math.floor(scale.length / 2);
      bestLabel = scale[mid];
    }

    // Compute confidence based on how many scale items were present
    const matchedCount = scale.filter(l => lower.includes(l.toLowerCase())).length;
    const confidence = matchedCount > 0 ? Math.min(0.4 + matchedCount * 0.2, 0.95) : 0.4;
    return { choice: bestLabel, confidence };
  }
}