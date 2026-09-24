/**
 * Checks the filament library and the matching that picks out of it.
 *
 * <p>Run with {@code npx tsx tools/check-filaments.mts} from the repository
 * root. It reads the committed snapshot, so it says nothing about whether the
 * server's refresh works -- it says whether the file is shaped the way the
 * picker believes and whether "the nearest spool to this colour" is an answer
 * anybody would accept.
 *
 * <p>Which is the part worth checking. A nearest-colour search that is quietly
 * wrong does not throw and does not look broken: it just puts a build on
 * plausible, wrong spools.
 */
import { readFileSync } from "node:fs";
import { closest, distance, nearest, search, colourOf, type Library } from "../web/src/slots/library.js";

let problems = 0;
const fail = (m: string): void => { problems++; console.log("  FAIL " + m); };
const ok = (m: string): void => console.log("  ok   " + m);

const library = JSON.parse(readFileSync("web/public/filaments.json", "utf8")) as Library;
const colours = library.brands.reduce((sum, brand) => sum + brand.colours.length, 0);
console.log(`${library.source} ${library.version}: ${library.brands.length} makers, ${colours} colours\n`);

// --- the file is shaped the way the picker believes --------------------------
{
  let bad = 0;
  let noDensity = 0;
  for (const brand of library.brands) {
    for (const colour of brand.colours) {
      if (!/^[0-9A-F]{6}$/.test(colour.hex)) bad++;
      if (colour.name === "" || colour.product === "" || colour.material === "") bad++;
      if (typeof colour.density !== "number" || colour.density <= 0) noDensity++;
    }
  }
  if (bad === 0) {
    ok(`every one of the ${colours} colours has a six digit hex and a name, a product and a material`);
  } else {
    fail(`${bad} colours are missing something or have a hex that is not one`);
  }
  if (noDensity === 0) {
    ok("and a density, which is what turns a printed volume into grams");
  } else {
    fail(`${noDensity} colours have no usable density`);
  }

  // The five this is being shown to had better be in it.
  const missing = ["Bambu Lab", "Prusament", "Snapmaker", "FLASHFORGE", "Creality"].filter(
    (name) => !library.brands.some((brand) => brand.name === name),
  );
  if (missing.length === 0) {
    ok("the five makers the pitch goes to are all in there");
  } else {
    fail(`missing: ${missing.join(", ")}`);
  }
}

// --- the matching ------------------------------------------------------------
{
  const bambu = library.brands.find((brand) => brand.name === "Bambu Lab");
  if (bambu === undefined) {
    fail("no Bambu Lab to match against");
  } else {
    // Sorted, and sorted the right way round.
    const sorted = nearest(bambu, 0x3366cc);
    const gaps = sorted.map((colour) => distance(colour, 0x3366cc));
    if (sorted.length === bambu.colours.length && gaps.every((gap, i) => i === 0 || gap >= (gaps[i - 1] as number) - 1e-9)) {
      ok(`nearest gives back all ${sorted.length} colours, nearest first`);
    } else {
      fail(`nearest gave ${sorted.length} of ${bambu.colours.length}, in ${gaps.slice(0, 5).map((g) => g.toFixed(3)).join(" ")}`);
    }

    // A colour a maker sells exactly must match itself, or the measure is off.
    let wrong = 0;
    for (const colour of bambu.colours.slice(0, 200)) {
      const match = closest(bambu, colourOf(colour));
      if (match === null || colourOf(match) !== colourOf(colour)) wrong++;
    }
    if (wrong === 0) {
      ok("a colour the maker sells exactly matches itself, all 200 tried");
    } else {
      fail(`${wrong} of 200 colours did not match themselves`);
    }

    // And the obvious ones land where anybody would say they should.
    const wanted: Array<[string, number, (hex: number) => boolean]> = [
      ["black", 0x000000, (hex) => hex < 0x202020],
      ["white", 0xffffff, (hex) => ((hex >> 16) & 0xff) > 0xe0 && (hex & 0xff) > 0xe0],
      ["red", 0xff0000, (hex) => ((hex >> 16) & 0xff) > 0x90 && ((hex >> 8) & 0xff) < 0x60 && (hex & 0xff) < 0x60],
      ["green", 0x00ff00, (hex) => ((hex >> 8) & 0xff) > 0x90 && ((hex >> 16) & 0xff) < 0xa0],
      ["blue", 0x0000ff, (hex) => (hex & 0xff) > 0x90 && ((hex >> 16) & 0xff) < 0x80],
    ];
    const misses: string[] = [];
    for (const [name, want, accepts] of wanted) {
      const match = closest(bambu, want);
      if (match === null || !accepts(colourOf(match))) {
        misses.push(`${name} -> ${match === null ? "nothing" : `${match.name} #${match.hex}`}`);
      }
    }
    if (misses.length === 0) {
      ok("black, white, red, green and blue each land on a spool of that colour");
    } else {
      fail(`matched badly: ${misses.join("; ")}`);
    }

    // Searching finds what it is asked for and nothing else.
    const matte = search(bambu, "matte");
    if (matte.length > 0 && matte.every((c) => `${c.name} ${c.product} ${c.material}`.toLowerCase().includes("matte"))) {
      ok(`searching "matte" finds ${matte.length} colours, every one of them matte`);
    } else {
      fail(`searching "matte" gave ${matte.length}, not all matte`);
    }
    if (search(bambu, "").length === bambu.colours.length) {
      ok("and an empty search is everything rather than nothing");
    } else {
      fail("an empty search dropped colours");
    }
  }
}

// --- what a build would actually get -----------------------------------------
{
  // The colours a Minecraft village clusters onto, near enough.
  const village = [0x6a9c3e, 0xb08a4e, 0x7a7a7a, 0x8b5a2b, 0x9c7a4a, 0xc8e4e8, 0xe9ecec, 0x4a3219];
  for (const name of ["Bambu Lab", "Prusament", "Snapmaker", "FLASHFORGE", "Creality"]) {
    const brand = library.brands.find((one) => one.name === name);
    if (brand === undefined) continue;
    const gaps = village.map((want) => {
      const match = closest(brand, want);
      return match === null ? Infinity : distance(match, want);
    });
    const worst = Math.max(...gaps);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // Under a tenth in Oklab is a colour somebody would call the same one.
    if (worst < 0.1) {
      ok(`${name.padEnd(11)} covers a village: worst off by ${worst.toFixed(3)}, average ${mean.toFixed(3)}`);
    } else {
      fail(`${name} is off by ${worst.toFixed(3)} on one of a village's colours`);
    }
  }
}

console.log(problems === 0 ? "\nALLE PRUEFUNGEN BESTANDEN" : `\n${problems} PROBLEME`);
process.exit(problems === 0 ? 0 : 1);
