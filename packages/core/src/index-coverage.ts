export const coverageQuietUs = 30_000_000;

export type CoverageInput = {
  sinceLastChosenUs: number;
  pictureChanged: boolean;
  pointerTravelPt: number;
  displayWidthPt: number;
};

/** The shared coverage gate for source and project picture selection. */
export function coverageDue(input: CoverageInput): boolean {
  return (
    input.pictureChanged &&
    (input.sinceLastChosenUs >= coverageQuietUs || input.pointerTravelPt >= input.displayWidthPt)
  );
}
