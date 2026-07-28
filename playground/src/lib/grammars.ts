export const irGrammar = {
  name: "ir",
  scopeName: "source.ir",
  patterns: [
    {
      // Section header for outputs attached to a node.
      name: "keyword.control.section.ir",
      match: "\\boutputs:",
    },
    {
      // `ref(name)` token in an output's path template.
      name: "support.function.ref.ir",
      match: "\\bref(?=\\()",
    },
    {
      name: "entity.name.tag.ir",
      match: "\\[[^\\]]+\\]",
    },
    {
      name: "meta.block.ir",
      begin: "\\{",
      end: "\\}",
      patterns: [
        {
          name: "variable.parameter.ir",
          match: "\\b[a-z_]+(?==)",
        },
        {
          name: "keyword.operator.ir",
          match: "=",
        },
        {
          name: "constant.numeric.ir",
          match: "\\b\\d+\\b",
        },
        {
          name: "string.quoted.double.ir",
          match: '"[^"]*"',
        },
      ],
    },
    {
      name: "meta.range.ir",
      match: "\\(([\\d.-]+)\\.\\.([\\d.-]+|∞)\\)",
    },
    {
      name: "string.quoted.double.ir",
      match: '"[^"]*"',
    },
    {
      name: "keyword.control.ir",
      match: "\\b(sequence|alternative|optional|repeat|literal|int|float|str|path)\\b",
    },
    {
      name: "variable.parameter.ir",
      match: "\\bjoin\\b",
    },
    {
      name: "constant.numeric.ir",
      match: "\\b-?\\d+(?:\\.\\d+)?\\b",
    },
  ],
};

/**
 * argtype DSL grammar, mirrored from the canonical TextMate grammar in the
 * argtype spec repo (docs/.vitepress/languages/argtype.tmLanguage.json). Keep
 * the two in sync; the input editor uses a matching CodeMirror StreamLanguage
 * in `argtype-mode.ts`.
 */
export const argtypeGrammar = {
  name: "argtype",
  scopeName: "source.argtype",
  patterns: [
    { include: "#frontmatter" },
    { include: "#doc-comment" },
    { include: "#line-comment" },
    { include: "#type-alias" },
    { include: "#combinator" },
    { include: "#terminal" },
    { include: "#template-literal" },
    { include: "#string" },
    { include: "#method-chain" },
    { include: "#label" },
    { include: "#number" },
    { include: "#operator" },
    { include: "#punctuation" },
  ],
  repository: {
    frontmatter: {
      name: "meta.frontmatter.argtype",
      begin: "\\A(---)",
      end: "^(---)",
      beginCaptures: { "1": { name: "punctuation.definition.frontmatter.argtype" } },
      endCaptures: { "1": { name: "punctuation.definition.frontmatter.argtype" } },
      patterns: [
        { name: "entity.name.tag.yaml", match: "^\\s*([\\w.-]+)\\s*:" },
        { include: "#string" },
        { name: "constant.numeric.argtype", match: "\\b\\d[\\d.]*\\b" },
      ],
    },
    "doc-comment": {
      name: "comment.line.documentation.argtype",
      match: "///.*$",
    },
    "line-comment": {
      name: "comment.line.double-slash.argtype",
      match: "//.*$",
    },
    "type-alias": {
      match: "^\\s*([A-Z][A-Za-z0-9]*)\\s*(=)",
      captures: {
        "1": { name: "entity.name.type.argtype" },
        "2": { name: "keyword.operator.assignment.argtype" },
      },
    },
    combinator: {
      match: "\\b(seq|set|opt|rep|alt|any)\\s*(?=\\()",
      name: "keyword.control.combinator.argtype",
    },
    terminal: {
      match: "\\b(int|float|str|path)\\b",
      name: "support.type.terminal.argtype",
    },
    "template-literal": {
      name: "string.template.argtype",
      begin: "`",
      end: "`",
      patterns: [
        {
          name: "meta.template.expression.argtype",
          begin: "\\{",
          end: "\\}",
          patterns: [
            { name: "variable.other.reference.argtype", match: "[A-Za-z_][A-Za-z0-9_]*" },
            { name: "punctuation.accessor.argtype", match: "\\." },
            { include: "#string" },
          ],
        },
      ],
    },
    string: {
      name: "string.quoted.double.argtype",
      begin: '"',
      end: '"',
    },
    "method-chain": {
      match: "(\\.)([A-Za-z_][A-Za-z0-9_]*)\\s*(?=\\()",
      captures: {
        "1": { name: "punctuation.accessor.argtype" },
        "2": { name: "entity.name.function.method.argtype" },
      },
    },
    label: {
      match: "\\b([a-z_][A-Za-z0-9_]*)\\s*(:)(?!=)",
      captures: {
        "1": { name: "variable.other.label.argtype" },
        "2": { name: "punctuation.separator.label.argtype" },
      },
    },
    number: {
      name: "constant.numeric.argtype",
      match: "-?\\b\\d+(\\.\\d+)?\\b",
    },
    operator: {
      patterns: [
        { name: "keyword.operator.alternative.argtype", match: "\\|" },
        { name: "keyword.operator.assignment.argtype", match: "=" },
      ],
    },
    punctuation: {
      patterns: [
        { name: "punctuation.parenthesis.open.argtype", match: "\\(" },
        { name: "punctuation.parenthesis.close.argtype", match: "\\)" },
        { name: "punctuation.separator.comma.argtype", match: "," },
      ],
    },
  },
};

export const bindingsGrammar = {
  name: "bindings",
  scopeName: "source.bindings",
  // Order matters: where two patterns match at the same offset the earlier one
  // wins, so the line-anchored headings come before the generic name rules.
  patterns: [
    { include: "#section" },
    { include: "#scope" },
    { include: "#diagnostic" },
    { include: "#tag" },
    { include: "#row" },
    { include: "#iter" },
    { include: "#call" },
    { include: "#token-flags" },
    { include: "#media" },
    { include: "#gate-keyword" },
    { include: "#type" },
    { include: "#params" },
    { include: "#qualifier" },
    { include: "#variant" },
    { include: "#label" },
    { include: "#binding-ref" },
    { include: "#string" },
    { include: "#number" },
    { include: "#punctuation" },
  ],
  repository: {
    section: {
      // `bindings:` / `outputs:` / `diagnostics:` at the left margin. A heading
      // is always the whole line, and anchoring says so - otherwise a binding
      // that happens to be named `outputs` would render as one.
      name: "keyword.control.section.bindings",
      match: "^(bindings|outputs|diagnostics):$",
    },
    scope: {
      // `on <binding>:` heads the outputs declared on one scope.
      match: "^(\\s*)(on)\\s+([^:]+)(:)",
      captures: {
        "2": { name: "keyword.control.section.bindings" },
        "3": {
          name: "entity.name.function.bindings",
          patterns: [{ include: "#qualifier" }],
        },
      },
    },
    diagnostic: {
      // `[error] out: message`. Taken as a whole line so the free-prose message
      // is not scanned for words that happen to look like types or keywords.
      match: "^(\\s*)(\\[(?:error|warning)\\])\\s+([^:]*)(:)(.*)$",
      captures: {
        "2": { name: "invalid.illegal.bindings" },
        "3": { name: "entity.name.function.bindings" },
      },
    },
    tag: {
      // `[optional]`, and the `[arm]` marking which union arm a row is in.
      name: "entity.name.tag.bindings",
      match: "\\[[^\\]]+\\]",
    },
    row: {
      // The binding each row is about. Its `#qualifier` is scoped separately,
      // so this deliberately stops at the base name.
      //
      // Binding names take `entity.name` scopes rather than the more literal
      // `variable.other`: themes reliably colour the former, and a row label
      // and every reference to it then share one colour, which is what lets a
      // `ref(...)` be matched back to its row by eye.
      match: "^(\\s*)([A-Za-z_]\\w*)",
      captures: { "2": { name: "entity.name.function.bindings" } },
    },
    iter: {
      // `<iter:binding>` - the repeat a loop variable is drawn from.
      begin: "(<)(iter)(:)",
      beginCaptures: {
        "1": { name: "punctuation.definition.bindings" },
        "2": { name: "support.function.bindings" },
        "3": { name: "punctuation.definition.bindings" },
      },
      end: "(>)",
      endCaptures: { "1": { name: "punctuation.definition.bindings" } },
      patterns: [{ include: "#qualifier" }, { include: "#binding-ref" }],
    },
    call: {
      // `ref(binding)` output tokens and `present(...)` / `iter(...)` gates.
      begin: "\\b(ref|present|iter)(\\()",
      beginCaptures: {
        "1": { name: "support.function.bindings" },
        "2": { name: "punctuation.parenthesis.open.bindings" },
      },
      end: "(\\))",
      endCaptures: { "1": { name: "punctuation.parenthesis.close.bindings" } },
      patterns: [{ include: "#qualifier" }, { include: "#binding-ref" }],
    },
    "token-flags": {
      // A ref's `{strip=[...], fallback="..."}` suffix. Pinned to those keys so
      // it cannot swallow a `struct {` in the type tree.
      name: "meta.block.bindings",
      begin: "\\{(?=\\s*(?:strip|fallback)=)",
      end: "\\}",
      patterns: [
        { name: "variable.parameter.bindings", match: "\\b[a-z_]+(?==)" },
        { name: "keyword.operator.bindings", match: "=" },
        { include: "#string" },
      ],
    },
    media: {
      // An output's ` (image/nifti, image/dicom)` media-type list, kept whole so
      // a `+` inside a subtype does not read as an operator.
      name: "string.unquoted.media.bindings",
      match: "\\([a-z][\\w.+-]*/[^)]*\\)",
    },
    "gate-keyword": {
      name: "keyword.control.gate.bindings",
      match: "(?<![.#])\\b(when|AND|OR)\\b",
    },
    type: {
      // Guarded against a preceding `.` or `#` so an access segment or a
      // qualifier spelled like a type - `params.path`, `x#list` - stays a name.
      // Parameters really are named things like `path` and `count`.
      name: "storage.type.bindings",
      match: "(?<![.#])\\b(struct|union|optional|list|bool|count|int|float|str|path)\\b",
    },
    params: {
      // The root every access path is written against.
      name: "variable.language.bindings",
      match: "(?<![.#])\\bparams\\b",
    },
    qualifier: {
      // The `#flag` / `#list` / `#arm` suffix that makes a name unique.
      name: "entity.name.tag.qualifier.bindings",
      match: "#[A-Za-z_]\\w*",
    },
    variant: {
      // The `=arm` half of a variant gate atom.
      match: "(=)([A-Za-z_]\\w*)",
      captures: {
        "1": { name: "keyword.operator.bindings" },
        "2": { name: "entity.name.tag.bindings" },
      },
    },
    label: {
      name: "entity.name.function.bindings",
      match: "\\b[A-Za-z_]\\w*(?=:)",
    },
    "binding-ref": {
      // Any name left over once the rules above have had their say: the target
      // of a `ref(...)`/`present(...)` call, the binding half of a `=arm` gate
      // atom, and the field segments of an access path. Sharing the row-label
      // colour is the point - it is what lets a reference be matched by eye to
      // the row that declares it.
      name: "entity.name.function.bindings",
      match: "[A-Za-z_]\\w*",
    },
    string: {
      name: "string.quoted.double.bindings",
      match: '"[^"]*"',
    },
    number: {
      // Literal types can be negative or fractional, e.g. `-1.5`.
      name: "constant.numeric.bindings",
      match: "-?\\b\\d+(?:\\.\\d+)?\\b",
    },
    punctuation: {
      patterns: [
        { name: "keyword.operator.bindings", match: "[|+]" },
        { name: "punctuation.definition.typeparameters.bindings", match: "[<>]" },
      ],
    },
  },
};
