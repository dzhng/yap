# Journal format fixtures

These synthetic journals pin capture observations through the production writer
and readers. They contain no user recording or media.

The long-stroke fixture comes from the native
[fixture generator](../../helpers/mac/Tests/YapCaptureTests/LongStrokeFixture.swift):
fixed clocks and 60 Hz coordinates stand in for hardware, and `CaptureJournal`
owns serialization. To reproduce it, build `YapCaptureTests`, run it with
`YAP_LONG_STROKE_FIXTURE` naming a new scratch file, and compare that file with the
retained journal. Existing output paths refuse replacement.

The service import check synthesizes its own tiny movie in an isolated home;
native evidence export and media probing remain real. Historical normalized
byte references belong to the native [export tests](../../helpers/mac/Tests/fixtures/journal-goldens/README.md).
The TypeScript native integration cases run with `YAP_NATIVE` explicitly naming
the built worker. Build the sibling `YapCaptureTests` product too: it generates
repeated strokes and synthetic movie pictures in scratch space, without an
external encoder prerequisite.

Schema-4 fixtures come from the native
[summary tests](../../helpers/mac/Tests/YapCaptureTests/Schema4Tests.swift), using real journal
and publication writers. Pins and strokes are summary facts only while they survive undo.
Set `YAP_SCHEMA4_SUMMARY=1` and `YAP_SCHEMA4_FIXTURE_DIRECTORY` to a new scratch directory
to generate them. Optional take facts stay absent on historical receipts; re-publication never
adds facts to an existing receipt.
