import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUIA_A_MANO } from "@/lib/schemas/dashboard";
import { indiceGuia } from "./guia";

// Raw HTML is not rendered (no rehype-raw), so `<commit>` outside code would
// silently vanish from the page and the PDF.
describe("docs/guia-usuario.md", () => {
  it("no tiene texto entre ángulos fuera de código", () => {
    const md = readFileSync(
      path.join(process.cwd(), "docs", "guia-usuario.md"),
      "utf-8",
    );
    const sinCodigo = md
      .replace(/^(```|~~~)[\s\S]*?^\1/gm, "")
      .replace(/`[^`\n]*`/g, "");
    expect(sinCodigo.match(/<[A-Za-z][^>\n]*>/g) ?? []).toEqual([]);
  });

  // The Backups tab links there to explain the .panel/ restore by hand.
  it("tiene la sección a la que enlaza «Se restaura a mano»", () => {
    const md = readFileSync(
      path.join(process.cwd(), "docs", "guia-usuario.md"),
      "utf-8",
    );
    expect(indiceGuia(md).map((e) => `/guia#${e.ancla}`)).toContain(
      GUIA_A_MANO,
    );
  });
});
