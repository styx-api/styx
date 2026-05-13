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
