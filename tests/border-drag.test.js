import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.resolve(__dirname, "../public/order/index.html");

function seededPhoto(id, border) {
  return { id, name: id + ".jpg", url: "", w: 3600, h: 4000,
    paper: "pg-baryta", size: "11×14", border, qty: 1, posX: 50, posY: 50,
    julie: false, adjust: { exposure: 0, contrast: 0, saturation: 0, warmth: 0, straighten: 0 },
    recipe: null, editedPreview: null };
}

// Loads the real order page, runs the real renderCrops, returns the two preview imgs.
function renderStep3(photos) {
  const dom = new JSDOM(fs.readFileSync(INDEX, "utf8"), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://order.pochronstudios.com/order/",
    beforeParse(w) { w.fetch = () => Promise.reject(new Error("no network in test")); },
  });
  const win = dom.window;
  const state = win.eval("state");   // top-level const, reached via in-scope eval
  state.photos.length = 0;
  state.photos.push(...photos);
  win.eval("renderCrops")();
  const frames = [...win.document.querySelectorAll("#cropList .cropframe")];
  return {
    bordered: frames.find(f => f.classList.contains("bordered")).querySelector("img"),
    fill: frames.find(f => !f.classList.contains("bordered")).querySelector("img"),
  };
}

describe("white-border preview stays centered", () => {
  it("does not wire drag onto a bordered frame (object-position can't be shoved off 50% 50%)", () => {
    const { bordered } = renderStep3([seededPhoto("b", "border"), seededPhoto("f", "none")]);
    expect(typeof bordered.onpointerdown).not.toBe("function");
  });

  it("still wires drag onto fill-mode frames (repositioning preserved)", () => {
    const { fill } = renderStep3([seededPhoto("b", "border"), seededPhoto("f", "none")]);
    expect(typeof fill.onpointerdown).toBe("function");
  });
});
