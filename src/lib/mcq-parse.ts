// Single source of truth for MCQ bulk-upload parsing.
// MCQ Practice and Mock Import must both call this parser so identical text
// always produces identical structured question rows.

export type ParsedMcq = {
  question: string;
  question_type: "mcq" | "true_false";
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: "A" | "B" | "C" | "D";
  explanation: string;
};

export type ParsedMcqResult = {
  cards: ParsedMcq[];
  invalidBlocks: { raw: string; reason: string }[];
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const QUESTION_START_RE =
  /^\s*(?:(?:q(?:uestion)?\s*\.?\s*)?\d{1,4}[).:\-]\s+\S|(?:q|question)\s*[:.)\-]\s+\S|(?:tf|true[_\s/-]?false|t\/f)\s*[:.)\-]\s+\S)/i;

function splitBlocks(input: string): string[] {
  const text = input.replace(/\r\n?/g, "\n").trim();
  if (!text) return [];

  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (QUESTION_START_RE.test(line) && current.some((l) => l.trim())) {
      blocks.push(current.join("\n").trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.some((l) => l.trim())) blocks.push(current.join("\n").trim());

  if (blocks.length > 1) return blocks.filter(Boolean);

  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
  const completeParagraphs = paragraphs.filter(looksLikeCompleteMcqBlock);
  if (paragraphs.length > 1 && completeParagraphs.length === paragraphs.length) return paragraphs;

  return [text];
}

function looksLikeCompleteMcqBlock(block: string): boolean {
  return (
    /(^|\n)\s*\(?A\)?\s*[).:\-]/i.test(block) &&
    /(^|\n)\s*\(?B\)?\s*[).:\-]/i.test(block) &&
    /(^|\n)\s*\(?C\)?\s*[).:\-]/i.test(block) &&
    /(^|\n)\s*\(?D\)?\s*[).:\-]/i.test(block) &&
    /(^|\n)\s*(?:answer|ans|correct(?:\s+answer)?|correct\s+option)\s*[:.\-)]/i.test(block)
  );
}

function parseBlock(raw: string): { mcq: ParsedMcq | null; reason?: string } {
  const stripped = raw
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*(?:q|question)\s*[:.\-)]\s*/i, "")
    .replace(/^\s*Q(?:uestion)?\s*\.?\s*\d{1,4}[).:\-]?\s*/i, "")
    .replace(/^\s*\d{1,4}[).:\-]\s*/i, "")
    .trim();
  if (!stripped) return { mcq: null, reason: "Empty question block" };

  const tfHead = stripped.match(/^\s*(?:tf|true[_\s/-]?false|t\/f)\s*[:.\)\-]\s*([\s\S]+)$/i);
  if (tfHead) {
    const body = tfHead[1];
    const ansM = body.match(/(?:^|\n)\s*(?:answer|ans|correct(?:\s+answer)?|correct\s+option)\s*[:.\-)]\s*([^\n]+)/i);
    const expM = body.match(/(?:^|\n)\s*(?:explanation|explain|solution|reason)\s*[:.\-)]\s*([\s\S]*)$/i);
    if (!ansM) return { mcq: null, reason: "True/False missing answer" };
    const cuts = [ansM.index, expM?.index].filter((x): x is number => typeof x === "number");
    const tfQuestion = norm(body.slice(0, cuts.length ? Math.min(...cuts) : body.length));
    const a = ansM[1].toLowerCase().replace(/[^a-z]/g, "");
    const correct: "A" | "B" =
      a === "true" || a === "t" || a === "a"
        ? "A"
        : a === "false" || a === "f" || a === "b"
          ? "B"
          : "A";
    if (!["true", "t", "a", "false", "f", "b"].includes(a))
      return { mcq: null, reason: `Could not resolve True/False answer "${ansM[1].trim()}"` };
    return {
      mcq: {
        question: tfQuestion.slice(0, 4000),
        question_type: "true_false",
        option_a: "True",
        option_b: "False",
        option_c: "",
        option_d: "",
        correct_option: correct,
        explanation: norm(expM?.[1] ?? "").slice(0, 4000),
      },
    };
  }

  const optRe = /(^|\n)[ \t]*\(?([A-Da-d])\)?[ \t]*[).:\-][ \t]*/g;
  const markers: { letter: "A" | "B" | "C" | "D"; index: number; matchLen: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = optRe.exec(stripped)) !== null) {
    markers.push({
      letter: match[2].toUpperCase() as "A" | "B" | "C" | "D",
      index: match.index + match[1].length,
      matchLen: match[0].length - match[1].length,
    });
  }

  const firstOf = (letter: "A" | "B" | "C" | "D") => markers.find((m) => m.letter === letter);
  const mA = firstOf("A");
  const mB = firstOf("B");
  const mC = firstOf("C");
  const mD = firstOf("D");
  if (!mA || !mB || !mC || !mD || !(mA.index < mB.index && mB.index < mC.index && mC.index < mD.index)) {
    return { mcq: null, reason: "Need 4 options A–D" };
  }

  const question = norm(stripped.slice(0, mA.index));
  if (!question) return { mcq: null, reason: "Missing question text" };

  const afterD = stripped.slice(mD.index + mD.matchLen);
  const ansRe = /(?:^|\n)?\s*(?:answer|ans|correct(?:\s+answer)?|correct\s+option)\s*[:.\-)]?\s*(.+?)(?=\n\s*(?:explanation|explain|solution|reason)\s*[:.\-)]|$)/i;
  const expRe = /(?:^|\n)\s*(?:explanation|explain|solution|reason)\s*[:.\-)]\s*([\s\S]*)$/i;
  const ansMatch = ansRe.exec(afterD);
  const expMatch = expRe.exec(afterD);
  if (!ansMatch) return { mcq: null, reason: "Missing answer" };

  const cuts = [ansMatch.index, expMatch?.index].filter((x): x is number => typeof x === "number");
  const optionD = afterD.slice(0, cuts.length ? Math.min(...cuts) : afterD.length);
  const between = (a: typeof mA, b: typeof mA) => stripped.slice(a.index + a.matchLen, b.index);
  const opts = {
    A: norm(between(mA, mB)),
    B: norm(between(mB, mC)),
    C: norm(between(mC, mD)),
    D: norm(optionD),
  };
  if (!opts.A || !opts.B || !opts.C || !opts.D) return { mcq: null, reason: "Need 4 options A–D" };

  let correct: "A" | "B" | "C" | "D" | null = null;
  const answer = norm(ansMatch[1]);
  const letter = answer.match(/^[(\[]?([A-Da-d])[)\].:]?$/);
  if (letter) {
    correct = letter[1].toUpperCase() as "A" | "B" | "C" | "D";
  } else {
    const a = answer.toLowerCase();
    for (const k of ["A", "B", "C", "D"] as const) {
      if (opts[k].toLowerCase() === a) {
        correct = k;
        break;
      }
    }
  }
  if (!correct) return { mcq: null, reason: `Could not resolve answer "${answer}"` };

  return {
    mcq: {
      question: question.slice(0, 4000),
      question_type: "mcq",
      option_a: opts.A.slice(0, 1000),
      option_b: opts.B.slice(0, 1000),
      option_c: opts.C.slice(0, 1000),
      option_d: opts.D.slice(0, 1000),
      correct_option: correct,
      explanation: norm(expMatch?.[1] ?? "").slice(0, 4000),
    },
  };
}

export function parseMcqText(input: string): ParsedMcqResult {
  const blocks = splitBlocks(input ?? "");
  const cards: ParsedMcq[] = [];
  const invalidBlocks: { raw: string; reason: string }[] = [];
  for (const b of blocks) {
    const { mcq, reason } = parseBlock(b);
    if (mcq) cards.push(mcq);
    else invalidBlocks.push({ raw: b, reason: reason ?? "Unparseable" });
  }
  return { cards, invalidBlocks };
}

/** Normalize a question for duplicate detection. */
export function fingerprintQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
