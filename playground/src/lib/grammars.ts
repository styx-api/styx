export const irGrammar = {
  name: "ir",
  scopeName: "source.ir",
  patterns: [
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
