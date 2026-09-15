import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../server/utils/security";

type VectorFile = {
  version: number;
  vectors: { name: string; input: string; expected: string }[];
};

const vectorFile = JSON.parse(
  readFileSync(new URL("../shared/jcs-vectors.json", import.meta.url), "utf8"),
) as VectorFile;

describe("RFC 8785 canonical JSON vectors", () => {
  it("ships a versioned, non-empty shared vector set", () => {
    expect(vectorFile.version).toBe(1);
    expect(vectorFile.vectors.length).toBeGreaterThan(0);
  });

  for (const vector of vectorFile.vectors) {
    it(`canonicalizes ${vector.name}`, () => {
      expect(canonicalJson(JSON.parse(vector.input))).toBe(vector.expected);
    });
  }
});