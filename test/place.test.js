import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlace, normalizePlaceType } from "../app/place.js";
import { cleanPlaceType } from "../workers/place/src/index.js";

test("place type normalization collapses descriptive restaurant subtypes", () => {
  assert.equal(normalizePlaceType("Japanese fine dining restaurant"), "restaurant");
  assert.equal(normalizePlaceType("Sushi bar"), "restaurant");
  assert.equal(cleanPlaceType("Japanese fine dining restaurant"), "restaurant");
});

test("place type normalization keeps broad place categories", () => {
  assert.equal(normalizePlaceType("Cocktail Bar"), "bar");
  assert.equal(normalizePlaceType("Art museum"), "museum");
  assert.equal(normalizePlaceType("Bookstore"), "bookstore");

  const place = normalizePlace({
    url: "https://example.com",
    name: "Example",
    type: "Modern art museum"
  });
  assert.equal(place.type, "museum");
});
