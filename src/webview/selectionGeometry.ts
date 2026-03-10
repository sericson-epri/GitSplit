export interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export function rectHasVisibleArea(rect: RectLike): boolean {
  return rect.width > 0 || rect.height > 0;
}

export function rectsIntersect(a: RectLike, b: RectLike): boolean {
  return a.top < b.bottom &&
    a.bottom > b.top &&
    a.left < b.right &&
    a.right > b.left;
}

export function rowIntersectsSelection(rowRect: RectLike, selectionRects: RectLike[]): boolean {
  return selectionRects
    .filter(rectHasVisibleArea)
    .some((selectionRect) => rectsIntersect(rowRect, selectionRect));
}