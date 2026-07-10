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
  patterns: [
    {
      // Section headers introduced by the resolved-outputs renderer.
      name: "keyword.control.section.bindings",
      match: "\\b(outputs|diagnostics):",
    },
    {
      // Annotations like [optional], [error], [warning].
      name: "entity.name.tag.bindings",
      match: "\\[(optional|error|warning)\\]",
    },
    {
      // Function-like gate atoms / output tokens.
      name: "support.function.bindings",
      match: "\\b(ref|present)(?=\\()",
    },
    {
      // Gate connectives in branch conditions.
      name: "keyword.control.gate.bindings",
      match: "\\b(when|for each|AND|OR)\\b",
    },
    {
      // Token-flag block: { strip=[...], fallback="" }.
      name: "meta.block.bindings",
      begin: "\\{",
      end: "\\}",
      patterns: [
        {
          name: "variable.parameter.bindings",
          match: "\\b[a-z_]+(?==)",
        },
        {
          name: "keyword.operator.bindings",
          match: "=",
        },
        {
          name: "string.quoted.double.bindings",
          match: '"[^"]*"',
        },
      ],
    },
    {
      name: "storage.type.bindings",
      match: "\\b(struct|union|optional|list|bool|count|literal|int|float|str|path)\\b",
    },
    {
      name: "variable.other.property.bindings",
      match: "\\b[a-zA-Z_]\\w*(?=:)",
    },
    {
      name: "string.quoted.double.bindings",
      match: '"[^"]*"',
    },
    {
      name: "constant.numeric.bindings",
      match: "\\b\\d+\\b",
    },
    {
      name: "keyword.operator.bindings",
      match: "\\|",
    },
    {
      name: "punctuation.definition.typeparameters.bindings",
      match: "[<>]",
    },
  ],
};
