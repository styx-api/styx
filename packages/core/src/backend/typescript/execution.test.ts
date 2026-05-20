import { describe, expect, it } from "vitest";
import {
  execute,
  float,
  int,
  lit,
  namedAlt,
  opt,
  path,
  rep,
  repJoin,
  seq,
  seqJoin,
  str,
} from "./test-helpers.js";

// -- Scalars --

describe("execution - scalars", () => {
  it("literal + string param", () => {
    const args = execute(seq(lit("tool"), str("name")), { name: "hello" }, { app: { id: "t" } });
    expect(args).toEqual(["tool", "hello"]);
  });

  it("int and float params are stringified", () => {
    const args = execute(
      seq(int("count"), float("ratio")),
      { count: 42, ratio: 3.14 },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["42", "3.14"]);
  });

  it("path params pass through execution.inputFile", () => {
    const args = execute(
      seq(lit("cmd"), path("infile")),
      { infile: "/data/brain.nii" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "/data/brain.nii"]);
  });

  it("all four scalar types in one struct", () => {
    const args = execute(
      seq(str("name"), int("count"), float("ratio"), path("file")),
      { name: "x", count: 5, ratio: 1.5, file: "/tmp/f" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["x", "5", "1.5", "/tmp/f"]);
  });

  it("int zero is stringified correctly", () => {
    const args = execute(seq(int("n")), { n: 0 }, { app: { id: "t" } });
    expect(args).toEqual(["0"]);
  });

  it("empty string is pushed as-is", () => {
    const args = execute(seq(str("val")), { val: "" }, { app: { id: "t" } });
    expect(args).toEqual([""]);
  });

  it("multiple literals in sequence", () => {
    const args = execute(seq(lit("a"), lit("b"), lit("c")), {}, { app: { id: "t" } });
    expect(args).toEqual(["a", "b", "c"]);
  });
});

// -- Optionals --

describe("execution - optionals", () => {
  it("optional param present", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("--name"), str("name")))),
      { name: "alice" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--name", "alice"]);
  });

  it("optional param absent (null)", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("--name"), str("name")))),
      { name: null },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("optional param absent (undefined)", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("--name"), str("name")))),
      { name: undefined },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("bool flag true", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("-v")), { name: "verbose", defaultValue: false })),
      { verbose: true },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "-v"]);
  });

  it("bool flag false", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("-v")), { name: "verbose", defaultValue: false })),
      { verbose: false },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("optional with nested flag + value", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("-t"), float("threshold")))),
      { threshold: 0.5 },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "-t", "0.5"]);
  });

  it("multiple optionals all present", () => {
    const args = execute(
      seq(
        lit("cmd"),
        opt(seq(lit("-a"), str("alpha"))),
        opt(seq(lit("-b"), int("beta"))),
        opt(seq(lit("-c"), float("gamma"))),
      ),
      { alpha: "x", beta: 42, gamma: 3.14 },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "-a", "x", "-b", "42", "-c", "3.14"]);
  });

  it("multiple optionals all absent", () => {
    const args = execute(
      seq(
        lit("cmd"),
        opt(seq(lit("-a"), str("alpha"))),
        opt(seq(lit("-b"), int("beta"))),
        opt(seq(lit("-c"), float("gamma"))),
      ),
      { alpha: null, beta: null, gamma: null },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("multiple optionals mixed present/absent", () => {
    const args = execute(
      seq(
        lit("cmd"),
        opt(seq(lit("-a"), str("alpha"))),
        opt(seq(lit("-b"), int("beta"))),
        opt(seq(lit("-c"), float("gamma"))),
      ),
      { alpha: "x", beta: null, gamma: 2.5 },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "-a", "x", "-c", "2.5"]);
  });

  it("optional struct with multiple fields present", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("--range"), int("min"), int("max")), { name: "range" })),
      { range: { min: 1, max: 10 } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--range", "1", "10"]);
  });

  it("optional struct with multiple fields absent", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("--range"), int("min"), int("max")), { name: "range" })),
      { range: null },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("optional wrapping path", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("--out"), path("outfile")))),
      { outfile: "/tmp/out.nii" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--out", "/tmp/out.nii"]);
  });

  it("optional wrapping path absent", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("--out"), path("outfile")))),
      { outfile: null },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });
});

// -- Repeats --

describe("execution - repeats", () => {
  it("repeat produces multiple args", () => {
    const args = execute(
      seq(lit("cmd"), rep(int("val"), "vals")),
      { vals: [1, 2, 3] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "1", "2", "3"]);
  });

  it("repeat with join produces single arg", () => {
    const args = execute(
      seq(lit("cmd"), repJoin(",", int("val"), "vals")),
      { vals: [10, 20, 30] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "10,20,30"]);
  });

  it("count repeat emits literal N times", () => {
    const args = execute(
      seq(lit("cmd"), rep(seq(lit("-v")), "verbosity")),
      { verbosity: 3 },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "-v", "-v", "-v"]);
  });

  it("count repeat with 0 emits nothing", () => {
    const args = execute(
      seq(lit("cmd"), rep(seq(lit("-v")), "verbosity")),
      { verbosity: 0 },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("empty repeat array produces no args", () => {
    const args = execute(
      seq(lit("cmd"), rep(int("val"), "vals")),
      { vals: [] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("repeat with single item", () => {
    const args = execute(
      seq(lit("cmd"), rep(int("val"), "vals")),
      { vals: [42] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "42"]);
  });

  it("repeat of strings (no String() wrapping)", () => {
    const args = execute(
      seq(lit("cmd"), rep(str("f"), "files")),
      { files: ["a.txt", "b.txt"] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "a.txt", "b.txt"]);
  });

  it("repeat of paths uses inputFile", () => {
    const args = execute(
      seq(lit("cmd"), rep(path("f"), "files")),
      { files: ["/a", "/b"] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "/a", "/b"]);
  });

  it("repeat(join) with single item produces no separator", () => {
    const args = execute(
      seq(lit("cmd"), repJoin(",", int("val"), "vals")),
      { vals: [42] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "42"]);
  });

  it("repeat(join) with empty array produces empty string", () => {
    const args = execute(
      seq(lit("cmd"), repJoin(",", int("val"), "vals")),
      { vals: [] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", ""]);
  });

  it("multiple repeats in same struct", () => {
    const args = execute(
      seq(lit("cmd"), rep(str("i"), "inputs"), rep(str("o"), "outputs")),
      { inputs: ["a", "b"], outputs: ["x"] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "a", "b", "x"]);
  });

  it("repeat of struct with flag and two fields", () => {
    const args = execute(
      seq(lit("cmd"), rep(seq(lit("--point"), float("x"), float("y")), "points")),
      {
        points: [
          { x: 1.0, y: 2.0 },
          { x: 3.0, y: 4.0 },
        ],
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--point", "1", "2", "--point", "3", "4"]);
  });
});

// -- Joins --

describe("execution - joins", () => {
  it("sequence with join concatenates into single arg", () => {
    const args = execute(
      seq(seqJoin("=", lit("--output"), str("out"))),
      { out: "/tmp/result" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["--output=/tmp/result"]);
  });

  it("nested joined seq: two strings concatenated", () => {
    const args = execute(
      seq(lit("cmd"), seqJoin("", str("left"), str("right"))),
      { left: "foo", right: "bar" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "foobar"]);
  });

  it("nested joined seq: literal separator between values", () => {
    const args = execute(
      seq(lit("cmd"), seqJoin("", str("x"), lit(","), str("y"))),
      { x: "10", y: "20" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "10,20"]);
  });

  it("nested joined seq inside joined seq (masks-style)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        lit("--masks"),
        seqJoin("", str("fixed_mask"), seqJoin("", lit(","), str("moving_mask"))),
      ),
      { fixed_mask: "brain.nii", moving_mask: "template.nii" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--masks", "brain.nii,template.nii"]);
  });

  it("optional inside joined seq: present", () => {
    const args = execute(
      seq(lit("cmd"), seqJoin("", opt(str("a")), lit(","), str("b"))),
      { a: "hello", b: "world" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "hello,world"]);
  });

  it("optional inside joined seq: absent", () => {
    const args = execute(
      seq(lit("cmd"), seqJoin("", opt(str("a")), lit(","), str("b"))),
      { a: null, b: "world" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", ",world"]);
  });

  it("repeat(join) inside joined seq", () => {
    const args = execute(
      seq(lit("cmd"), seqJoin("", lit("["), repJoin(",", int("v"), "vals"), lit("]"))),
      { vals: [1, 2, 3] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "[1,2,3]"]);
  });

  it("flag + joined value as single arg (flag-separator style)", () => {
    const args = execute(
      seq(lit("cmd"), opt(seqJoin("", lit("--output"), str("output")))),
      { output: "/path/to/file" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--output/path/to/file"]);
  });

  it("repeat of nested joined structs", () => {
    const args = execute(
      seq(lit("cmd"), rep(seqJoin("=", str("key"), str("val")), "pairs")),
      {
        pairs: [
          { key: "a", val: "1" },
          { key: "b", val: "2" },
        ],
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "a=1", "b=2"]);
  });

  it("repeat(join) of nested joined structs", () => {
    const args = execute(
      seq(lit("cmd"), repJoin(",", seqJoin("=", str("key"), str("val")), "pairs")),
      {
        pairs: [
          { key: "a", val: "1" },
          { key: "b", val: "2" },
        ],
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "a=1,b=2"]);
  });

  it("repeat(join) of paths", () => {
    const args = execute(
      seq(lit("cmd"), repJoin(":", path("p"), "paths")),
      { paths: ["/a", "/b", "/c"] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "/a:/b:/c"]);
  });

  it("nested: opt > seqJoin > lit + path", () => {
    const args = execute(
      seq(lit("cmd"), opt(seqJoin("=", lit("--input"), path("file")))),
      { file: "brain.nii" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--input=brain.nii"]);
  });
});

// -- Alternatives --

describe("execution - alternatives", () => {
  it("literal union alternative", () => {
    const args = execute(
      seq(lit("cmd"), namedAlt("mode", lit("fast"), lit("slow"))),
      { mode: "fast" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "fast"]);
  });

  it("literal union alternative (second variant)", () => {
    const args = execute(
      seq(lit("cmd"), namedAlt("mode", lit("fast"), lit("slow"))),
      { mode: "slow" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "slow"]);
  });

  it("bool alternative (true/false literals, true branch)", () => {
    const args = execute(
      seq(lit("cmd"), namedAlt("flag", lit("true"), lit("false"))),
      { flag: true },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "true"]);
  });

  it("bool alternative (true/false literals, false branch)", () => {
    // Solver recognizes true/false as bool pair. false branch emits the "false" literal.
    const args = execute(
      seq(lit("cmd"), namedAlt("flag", lit("true"), lit("false"))),
      { flag: false },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "false"]);
  });

  it("literal union with dash-prefixed values", () => {
    const args = execute(
      seq(lit("cmd"), namedAlt("flag", lit("--yes"), lit("--no"))),
      { flag: "--yes" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--yes"]);
  });

  it("three-way literal union", () => {
    const args = execute(
      seq(lit("cmd"), namedAlt("level", lit("low"), lit("medium"), lit("high"))),
      { level: "medium" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "medium"]);
  });

  it("discriminated union (first variant)", () => {
    // Variant names default to variant_0, variant_1 etc. when alts have no meta name
    const args = execute(
      seq(
        lit("cmd"),
        namedAlt("source", seq(lit("--file"), path("file")), seq(lit("--url"), str("url"))),
      ),
      { source: { "@type": "variant_0", file: "/data/input.nii" } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--file", "/data/input.nii"]);
  });

  it("discriminated union (second variant)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        namedAlt("source", seq(lit("--file"), path("file")), seq(lit("--url"), str("url"))),
      ),
      { source: { "@type": "variant_1", url: "https://example.com" } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--url", "https://example.com"]);
  });

  it("alternative inside optional (present)", () => {
    const args = execute(
      seq(lit("cmd"), opt(namedAlt("mode", lit("fast"), lit("slow")))),
      { mode: "fast" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "fast"]);
  });

  it("alternative inside optional (absent)", () => {
    const args = execute(
      seq(lit("cmd"), opt(namedAlt("mode", lit("fast"), lit("slow")))),
      { mode: null },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  // Regression: bool / union alternative inside a join previously emitted an
  // if/else block straight into the `[...].join(...)` array literal, producing
  // unparseable code. Each arm must be a ternary expression inside a join.
  it("bool alternative inside seqJoin emits valid ternary", () => {
    const args = execute(
      seq(seqJoin(",", lit("X"), namedAlt("flag", lit("0"), lit("1")))),
      { flag: true },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["X,0"]);
  });

  it("bool alternative inside seqJoin (false branch)", () => {
    const args = execute(
      seq(seqJoin(",", lit("X"), namedAlt("flag", lit("0"), lit("1")))),
      { flag: false },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["X,1"]);
  });

  it("bool alternative inside optional seqJoin (mirrors antsRegistration use_inverse)", () => {
    // opt(seqJoin("", lit(","), bool_alt)) inside an outer seqJoin: this is
    // the exact shape that broke antsRegistration's initial_moving_transform_use_inverse.
    const args = execute(
      seq(
        seqJoin(
          "",
          lit("["),
          path("infile"),
          opt(seqJoin("", lit(","), namedAlt("inv", lit("0"), lit("1")))),
          lit("]"),
        ),
      ),
      { infile: "/data/x.mat", inv: true },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["[/data/x.mat,0]"]);
  });

  it("bool alternative inside optional seqJoin (optional absent)", () => {
    const args = execute(
      seq(
        seqJoin(
          "",
          lit("["),
          path("infile"),
          opt(seqJoin("", lit(","), namedAlt("inv", lit("0"), lit("1")))),
          lit("]"),
        ),
      ),
      { infile: "/data/x.mat", inv: null },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["[/data/x.mat]"]);
  });

  // Mirror of the bool/union join fix for non-join repeats. Boutiques
  // produces `rep(seq(lit(FLAG), val))` inside a parent join template for
  // multi-occurrence flags (e.g. freesurfer mri_mark_temporal_lobe `-gradient
  // subject1 subject2 ...`); inside a join the repeat must concat into a
  // single arg, not push N statements.
  it("non-join repeat inside seqJoin concatenates per iteration", () => {
    const args = execute(
      seq(seqJoin("", lit("["), rep(str("name"), "names"), lit("]"))),
      { names: ["a", "b", "c"] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["[abc]"]);
  });

  it("non-join repeat inside seqJoin with multi-part body concatenates per iteration", () => {
    const args = execute(
      seq(seqJoin("", lit("["), rep(seq(lit(","), str("name")), "names"), lit("]"))),
      { names: ["a", "b"] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["[,a,b]"]);
  });

  it("discriminated union with seqJoin variants inside seqJoin emits chained ternary", () => {
    // Union variants must be Expr-shaped (seqJoin) for the chained-ternary
    // form. Variants whose body is a non-join seq emit cargs.push() statements
    // and would need hoisting, which we don't implement here.
    const args = execute(
      seq(
        seqJoin(
          ",",
          lit("X"),
          namedAlt(
            "kind",
            seqJoin("=", lit("a"), str("v1")),
            seqJoin("=", lit("b"), str("v2")),
          ),
        ),
      ),
      { kind: { "@type": "variant_1", v2: "hello" } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["X,b=hello"]);
  });
});

// -- Nesting: optional + repeat --

describe("execution - optional/repeat nesting", () => {
  it("optional containing repeat (collapsed access)", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("--items"), rep(int("v"), "vals")), { name: "items" })),
      { items: [1, 2, 3] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--items", "1", "2", "3"]);
  });

  it("optional containing repeat absent", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("--items"), rep(int("v"), "vals")), { name: "items" })),
      { items: null },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("optional containing repeat(join)", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("-c"), repJoin(",", float("coord"), "coords")))),
      { coords: [1.0, 2.5, 3.0] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "-c", "1,2.5,3"]);
  });

  it("optional containing repeat(join) absent", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("-c"), repJoin(",", float("coord"), "coords")))),
      { coords: null },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("repeat containing optional (some present, some absent)", () => {
    const args = execute(
      seq(lit("cmd"), rep(seq(str("name"), opt(seq(lit("--tag"), str("tag")))), "entries")),
      {
        entries: [
          { name: "a", tag: "x" },
          { name: "b", tag: null },
          { name: "c", tag: "z" },
        ],
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "a", "--tag", "x", "b", "c", "--tag", "z"]);
  });

  it("repeat containing optional (all absent)", () => {
    const args = execute(
      seq(lit("cmd"), rep(seq(str("name"), opt(seq(lit("--tag"), str("tag")))), "entries")),
      {
        entries: [
          { name: "a", tag: null },
          { name: "b", tag: null },
        ],
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "a", "b"]);
  });

  it("repeat containing bool flag", () => {
    const args = execute(
      seq(
        lit("cmd"),
        rep(
          seq(str("name"), opt(seq(lit("--force")), { name: "force", defaultValue: false })),
          "items",
        ),
      ),
      {
        items: [
          { name: "a", force: true },
          { name: "b", force: false },
        ],
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "a", "--force", "b"]);
  });
});

// -- Struct nesting --

describe("execution - struct nesting", () => {
  it("struct containing joined struct (struct-in-struct)", () => {
    const args = execute(
      seq(lit("cmd"), str("name"), seqJoin(":", str("host"), str("port"))),
      { name: "db", host: { host: "localhost", port: "5432" } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "db", "localhost:5432"]);
  });

  it("repeat of struct containing joined struct", () => {
    const args = execute(
      seq(
        lit("cmd"),
        rep(seq(lit("--ep"), str("name"), seqJoin(":", str("host"), str("port"))), "endpoints"),
      ),
      {
        endpoints: [
          { name: "a", host: { host: "h1", port: "1" } },
          { name: "b", host: { host: "h2", port: "2" } },
        ],
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--ep", "a", "h1:1", "--ep", "b", "h2:2"]);
  });

  it("masks-style microsyntax: nested optional structs in join", () => {
    const args = execute(
      seq(
        lit("cmd"),
        opt(
          seq(
            lit("--masks"),
            seqJoin("", str("fixed_mask"), seqJoin("", lit(","), str("moving_mask"))),
          ),
          { name: "masks" },
        ),
      ),
      { masks: { fixed_mask: "brain.nii", moving_mask: "template.nii" } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--masks", "brain.nii,template.nii"]);
  });

  it("masks-style microsyntax absent", () => {
    const args = execute(
      seq(
        lit("cmd"),
        opt(
          seq(
            lit("--masks"),
            seqJoin("", str("fixed_mask"), seqJoin("", lit(","), str("moving_mask"))),
          ),
          { name: "masks" },
        ),
      ),
      { masks: null },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("optional struct with three fields", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("--roi"), int("x"), int("y"), int("z")), { name: "roi" })),
      { roi: { x: 10, y: 20, z: 30 } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--roi", "10", "20", "30"]);
  });
});

// -- Complex combinations --

describe("execution - complex combinations", () => {
  it("mixed required, optional, repeat, join", () => {
    const args = execute(
      seq(
        lit("tool"),
        str("input"),
        opt(seq(lit("--threshold"), float("threshold"))),
        opt(seq(lit("-v")), { name: "verbose", defaultValue: false }),
        repJoin(",", int("dim"), "dims"),
      ),
      { input: "data.csv", threshold: 0.8, verbose: true, dims: [64, 128] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["tool", "data.csv", "--threshold", "0.8", "-v", "64,128"]);
  });

  it("some optionals absent in complex sequence", () => {
    const args = execute(
      seq(
        lit("tool"),
        str("input"),
        opt(seq(lit("--threshold"), float("threshold"))),
        opt(seq(lit("-v")), { name: "verbose", defaultValue: false }),
        rep(str("extra"), "extras"),
      ),
      { input: "data.csv", threshold: null, verbose: false, extras: ["a", "b"] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["tool", "data.csv", "a", "b"]);
  });

  it("repeat of struct with optional and required fields", () => {
    const args = execute(
      seq(
        lit("cmd"),
        rep(seq(str("name"), int("priority"), opt(seq(lit("--tag"), str("tag")))), "tasks"),
      ),
      {
        tasks: [
          { name: "build", priority: 1, tag: "ci" },
          { name: "test", priority: 2, tag: null },
        ],
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "build", "1", "--tag", "ci", "test", "2"]);
  });

  it("repeat of struct with multiple optionals", () => {
    const args = execute(
      seq(
        lit("cmd"),
        rep(
          seq(str("name"), opt(seq(lit("-a"), str("alpha"))), opt(seq(lit("-b"), int("beta")))),
          "items",
        ),
      ),
      {
        items: [
          { name: "x", alpha: "foo", beta: null },
          { name: "y", alpha: null, beta: 5 },
          { name: "z", alpha: null, beta: null },
        ],
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "x", "-a", "foo", "y", "-b", "5", "z"]);
  });

  it("optional joined sequence with three parts", () => {
    const args = execute(
      seq(lit("cmd"), opt(seqJoin(":", str("host"), int("port"), str("db")), { name: "conn" })),
      { conn: { host: "localhost", port: 5432, db: "mydb" } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "localhost:5432:mydb"]);
  });

  it("joined repeat of paths inside optional", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("--include"), repJoin(":", path("p"), "paths")))),
      { paths: ["/usr/lib", "/opt/lib"] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--include", "/usr/lib:/opt/lib"]);
  });

  it("joined repeat of paths inside optional absent", () => {
    const args = execute(
      seq(lit("cmd"), opt(seq(lit("--include"), repJoin(":", path("p"), "paths")))),
      { paths: null },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("realistic: tool with many argument types", () => {
    const args = execute(
      seq(
        lit("convert"),
        path("input"),
        opt(seq(lit("--output"), path("output"))),
        opt(seq(lit("--format"), namedAlt("fmt", lit("png"), lit("jpg"), lit("tiff")))),
        opt(seq(lit("--quality"), int("quality"))),
        opt(seq(lit("--resize"), seqJoin("x", int("width"), int("height"))), { name: "resize" }),
        opt(seq(lit("-v")), { name: "verbose", defaultValue: false }),
      ),
      {
        input: "photo.raw",
        output: "photo.png",
        fmt: "png",
        quality: 90,
        resize: { width: 800, height: 600 },
        verbose: true,
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual([
      "convert",
      "photo.raw",
      "--output",
      "photo.png",
      "--format",
      "png",
      "--quality",
      "90",
      "--resize",
      "800x600",
      "-v",
    ]);
  });

  it("realistic: tool with some args absent", () => {
    const args = execute(
      seq(
        lit("convert"),
        path("input"),
        opt(seq(lit("--output"), path("output"))),
        opt(seq(lit("--format"), namedAlt("fmt", lit("png"), lit("jpg"), lit("tiff")))),
        opt(seq(lit("--quality"), int("quality"))),
        opt(seq(lit("--resize"), seqJoin("x", int("width"), int("height"))), { name: "resize" }),
        opt(seq(lit("-v")), { name: "verbose", defaultValue: false }),
      ),
      {
        input: "photo.raw",
        output: null,
        fmt: null,
        quality: null,
        resize: null,
        verbose: false,
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["convert", "photo.raw"]);
  });

  it("repeat with flag per item (e.g. -I /path -I /path)", () => {
    const args = execute(
      seq(lit("gcc"), rep(seq(lit("-I"), path("dir")), "includes")),
      { includes: ["/usr/include", "/opt/include"] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["gcc", "-I", "/usr/include", "-I", "/opt/include"]);
  });

  it("two repeats interleaved with required args", () => {
    const args = execute(
      seq(lit("cmd"), str("mode"), rep(str("i"), "inputs"), lit("--"), rep(str("o"), "outputs")),
      { mode: "copy", inputs: ["a", "b"], outputs: ["x", "y", "z"] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "copy", "a", "b", "--", "x", "y", "z"]);
  });
});

// -- Deep nesting: alt combinations --

describe("execution - deep alt nesting", () => {
  it("alt inside rep (list of discriminated unions)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        rep(
          namedAlt("step", seq(lit("--copy"), path("src")), seq(lit("--move"), path("src"))),
          "steps",
        ),
      ),
      {
        steps: [
          { "@type": "variant_0", src: "/a" },
          { "@type": "variant_1", src: "/b" },
          { "@type": "variant_0", src: "/c" },
        ],
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--copy", "/a", "--move", "/b", "--copy", "/c"]);
  });

  it("alt inside rep with empty array", () => {
    const args = execute(
      seq(
        lit("cmd"),
        rep(
          namedAlt("step", seq(lit("--copy"), path("src")), seq(lit("--rm"), str("target"))),
          "steps",
        ),
      ),
      { steps: [] },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("rep inside alt variant (variant with repeated field)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        namedAlt(
          "input",
          seq(lit("--file"), path("file")),
          seq(lit("--batch"), rep(path("f"), "files")),
        ),
      ),
      { input: { "@type": "variant_1", files: ["/a", "/b", "/c"] } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--batch", "/a", "/b", "/c"]);
  });

  it("rep inside alt variant (first variant selected)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        namedAlt(
          "input",
          seq(lit("--file"), path("file")),
          seq(lit("--batch"), rep(path("f"), "files")),
        ),
      ),
      { input: { "@type": "variant_0", file: "/single" } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--file", "/single"]);
  });

  it("opt inside alt variant (variant with optional field)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        namedAlt(
          "source",
          seq(
            lit("--local"),
            path("file"),
            opt(seq(lit("--compress")), { name: "compress", defaultValue: false }),
          ),
          seq(lit("--remote"), str("url")),
        ),
      ),
      { source: { "@type": "variant_0", file: "/data", compress: true } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--local", "/data", "--compress"]);
  });

  it("opt inside alt variant (optional absent)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        namedAlt(
          "source",
          seq(
            lit("--local"),
            path("file"),
            opt(seq(lit("--compress")), { name: "compress", defaultValue: false }),
          ),
          seq(lit("--remote"), str("url")),
        ),
      ),
      { source: { "@type": "variant_0", file: "/data", compress: false } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--local", "/data"]);
  });

  it("optional discriminated union (present)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        opt(namedAlt("source", seq(lit("--file"), path("file")), seq(lit("--url"), str("url")))),
      ),
      { source: { "@type": "variant_0", file: "/data" } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--file", "/data"]);
  });

  it("optional discriminated union (absent)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        opt(namedAlt("source", seq(lit("--file"), path("file")), seq(lit("--url"), str("url")))),
      ),
      { source: null },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("rep > seq > alt (repeat of struct containing union)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        rep(seq(str("name"), namedAlt("kind", lit("read"), lit("write"), lit("exec"))), "perms"),
      ),
      {
        perms: [
          { name: "user", kind: "read" },
          { name: "group", kind: "exec" },
        ],
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "user", "read", "group", "exec"]);
  });

  it("rep > seq > alt with discriminated union variants", () => {
    const args = execute(
      seq(
        lit("cmd"),
        rep(
          seq(
            str("label"),
            namedAlt(
              "action",
              seq(lit("--copy"), path("src")),
              seq(lit("--delete"), str("target")),
            ),
          ),
          "ops",
        ),
      ),
      {
        ops: [
          { label: "first", action: { "@type": "variant_0", src: "/a" } },
          { label: "second", action: { "@type": "variant_1", target: "old" } },
        ],
      },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "first", "--copy", "/a", "second", "--delete", "old"]);
  });

  it("opt > seq > alt > seq > rep (four levels deep)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        opt(
          seq(
            lit("--transform"),
            namedAlt(
              "xform",
              seq(lit("rotate"), repJoin(",", float("angle"), "angles")),
              seq(lit("scale"), float("factor")),
            ),
          ),
          { name: "transform" },
        ),
      ),
      { transform: { "@type": "variant_0", angles: [90.0, 45.0] } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--transform", "rotate", "90,45"]);
  });

  it("opt > seq > alt > seq > rep (second variant)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        opt(
          seq(
            lit("--transform"),
            namedAlt(
              "xform",
              seq(lit("rotate"), repJoin(",", float("angle"), "angles")),
              seq(lit("scale"), float("factor")),
            ),
          ),
          { name: "transform" },
        ),
      ),
      { transform: { "@type": "variant_1", factor: 2.5 } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--transform", "scale", "2.5"]);
  });

  it("opt > seq > alt > seq > rep (absent)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        opt(
          seq(
            lit("--transform"),
            namedAlt(
              "xform",
              seq(lit("rotate"), repJoin(",", float("angle"), "angles")),
              seq(lit("scale"), float("factor")),
            ),
          ),
          { name: "transform" },
        ),
      ),
      { transform: null },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd"]);
  });

  it("alt with three complex variants (struct, scalar, repeat)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        namedAlt(
          "output",
          seq(lit("--split"), str("prefix"), int("chunks")),
          seq(lit("--single"), path("file")),
          seq(lit("--multi"), rep(path("f"), "files")),
        ),
      ),
      { output: { "@type": "variant_2", files: ["/x", "/y"] } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--multi", "/x", "/y"]);
  });

  it("alt with three complex variants (first variant - struct)", () => {
    const args = execute(
      seq(
        lit("cmd"),
        namedAlt(
          "output",
          seq(lit("--split"), str("prefix"), int("chunks")),
          seq(lit("--single"), path("file")),
          seq(lit("--multi"), rep(path("f"), "files")),
        ),
      ),
      { output: { "@type": "variant_0", prefix: "out_", chunks: 4 } },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "--split", "out_", "4"]);
  });

  it("multiple alts in same struct", () => {
    const args = execute(
      seq(
        lit("cmd"),
        namedAlt("mode", lit("fast"), lit("slow")),
        namedAlt("format", lit("json"), lit("csv"), lit("xml")),
      ),
      { mode: "fast", format: "csv" },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "fast", "csv"]);
  });

  it("alt + rep + opt all siblings in one struct", () => {
    const args = execute(
      seq(
        lit("cmd"),
        namedAlt("mode", lit("train"), lit("eval")),
        rep(path("f"), "inputs"),
        opt(seq(lit("--lr"), float("lr"))),
      ),
      { mode: "train", inputs: ["/data/a", "/data/b"], lr: 0.001 },
      { app: { id: "t" } },
    );
    expect(args).toEqual(["cmd", "train", "/data/a", "/data/b", "--lr", "0.001"]);
  });
});
