import * as assert from 'assert';
import { rectHasVisibleArea, rectsIntersect, rowIntersectsSelection, RectLike } from '../../webview/selectionGeometry';

function rect(overrides: Partial<RectLike>): RectLike {
  return {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    width: 0,
    height: 0,
    ...overrides,
  };
}

describe('selectionGeometry', () => {
  it('treats non-zero rectangles as visible', () => {
    assert.strictEqual(rectHasVisibleArea(rect({ width: 12, height: 0 })), true);
    assert.strictEqual(rectHasVisibleArea(rect({ width: 0, height: 16 })), true);
    assert.strictEqual(rectHasVisibleArea(rect({ width: 0, height: 0 })), false);
  });

  it('detects rectangle overlap', () => {
    const row = rect({ top: 100, right: 500, bottom: 120, left: 0, width: 500, height: 20 });
    const selection = rect({ top: 105, right: 240, bottom: 118, left: 80, width: 160, height: 13 });

    assert.strictEqual(rectsIntersect(row, selection), true);
  });

  it('rejects rectangles that only touch at the edge', () => {
    const row = rect({ top: 100, right: 500, bottom: 120, left: 0, width: 500, height: 20 });
    const selection = rect({ top: 120, right: 240, bottom: 140, left: 80, width: 160, height: 20 });

    assert.strictEqual(rectsIntersect(row, selection), false);
  });

  it('matches a row when any selection client rect overlaps it', () => {
    const row = rect({ top: 140, right: 500, bottom: 160, left: 0, width: 500, height: 20 });
    const selectionRects = [
      rect({ top: 80, right: 200, bottom: 95, left: 80, width: 120, height: 15 }),
      rect({ top: 145, right: 260, bottom: 155, left: 90, width: 170, height: 10 }),
    ];

    assert.strictEqual(rowIntersectsSelection(row, selectionRects), true);
  });

  it('ignores zero-area client rects and reports no overlap when none intersect', () => {
    const row = rect({ top: 140, right: 500, bottom: 160, left: 0, width: 500, height: 20 });
    const selectionRects = [
      rect({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }),
      rect({ top: 200, right: 260, bottom: 220, left: 90, width: 170, height: 20 }),
    ];

    assert.strictEqual(rowIntersectsSelection(row, selectionRects), false);
  });
});