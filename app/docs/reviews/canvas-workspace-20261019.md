# Canvas workspace verification — 2026-10-19

This work keeps both native engines and their save, history and task ownership paths. The shared chrome provides labeled tools, a contextual property inspector, common save vocabulary and connection feedback. Classic and smart pages load the same workspace adapters after their native presentation adapters.

## Functional verification

- `node tests/check-workspace-requirements.cjs`: 37 checks passed, including 320/390/768/1024/1440 px layouts, four appearances, optional account/API dialogs and reduced motion.
- `node tests/check-phase1-interactions.cjs`: 17 checks passed, including undo/redo, copied incoming links, textarea scrolling and wheel/trackpad behavior in both engines.
- `node tests/check-canvas-workspace.cjs`: 23 checks passed. Uses the real classic/smart pages with disposable runtime data and an offline provider fixture. Covers edits and native persistence, one undo per input session, no-op focus preserving redo, bounded coordinates, native model parameters, selection/hand/Space tools, port snap and invalid self drops, Escape, smart X cutter, dialog input isolation, mobile focus trap/backdrop, real minimum tool target sizes, native receipt ownership on copies, and cancellation listener counts after classic link gestures.
- No page exceptions, external requests or generation submissions were observed in those runs. Live providers, physical touch devices and real user projects were not used.

The click-after-edit test holds the pointer down for 100 ms: the inspector must retain its action button while input blur causes a native render. This prevents a real click from being lost when the inspector refreshes.

## Performance method

Run `node tests/check-workspace-performance.cjs` from `app`. Set `PYTHON_EXECUTABLE`, `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` if the runtimes are not on their default search paths. `WORKSPACE_PERFORMANCE_EVIDENCE` selects the output folder. The script starts a disposable local server and profile and blocks external requests and generation endpoints.

Headless Chromium 151.0.7922.34, 1500 × 1000 viewport, reduced motion, 100 or 500 synthetic nodes. Every fourth node is a local SVG image; the rest are text. Actual input drags a node by 120 × 70 px over 30 pointer steps, then issues 10 anchored wheel events. A scale assertion verifies that wheel input really reaches the canvas. Recorded evidence includes requestAnimationFrame intervals, PerformanceObserver long tasks, function timings and CDP heap/DOM/layout counters. Every retained smart minimap dot is compared with the native node rectangle, zoom must add zero node-geometry reads, and an actual minimap click must retain native viewport navigation.

This was a shared Windows workstation with concurrent backend validation. Frame intervals include host load, renderer work and automation timing; these are not FPS or stable latency guarantees. Timing is observational rather than a flaky pass/fail threshold.

## Evidenced hotspot and measurements

The native smart minimap rebuilt all map elements and read all node dimensions during each drag/viewport event. Its adapter now retains a world layer and cached node geometry, remeasuring changed or resized nodes and keeping the native navigation state. Engine save/history behavior is unchanged.

| Scene | Minimap drag cumulative ms before | First after | Final repeat | Minimap zoom cumulative ms before | First after | Final repeat |
|---|---:|---:|---:|---:|---:|---:|
| Smart, 100 nodes | 29.6 | 4.1 | 4.3 | 71.6 | 0.6 | 0.6 |
| Smart, 500 nodes | 252.5 | 4.6 | 6.1 | 498.6 | 0.7 | 1.1 |

The drag phase calls the smart map 30 times; the zoom phase calls it 10 times. These scoped function timings support removal of that hotspot, not a claim that all interaction cost has disappeared.

| Final repeat | Drag wall ms | Zoom wall ms | Drag frame interval p95 ms | Zoom frame interval p95 ms | Largest observed long task ms |
|---|---:|---:|---:|---:|---:|
| Classic, 100 nodes | 477 | 886 | 16.6 | 74.9 | 0 |
| Classic, 500 nodes | 799 | 1732 | 16.7 | 125.1 | 66 |
| Smart, 100 nodes | 507 | 682 | 16.7 | 50.0 | 72 |
| Smart, 500 nodes | 1510 | 1441 | 16.7 | 41.7 | 414 |

There is remaining large-scene work outside the map function. For example, the whole smart 500-node zoom took 1246 ms before, 1034 ms in the first optimized pass and 1441 ms in the final repeat; the final repeat still observed two long tasks totaling 785 ms. Shared load and native renderer/save work are included, and these runs do not isolate their individual causes. No overall frame-rate or latency improvement is claimed.

Raw local evidence is under `app/test-output/workspace-performance-before`, `workspace-performance-after`, `workspace-performance-final`, `canvas-workspace`, `workspace-requirements` and `workspace-interactions`. These ignored folders contain result JSON, browser screenshots and server logs; they are test artifacts rather than user data or release files.

## Integrated acceptance

After merging the workspace commits into the integration checkout with VERSION `0.10.2-studio.16`, the following scripts ran sequentially using the integration `.venv`: 17 interaction checks, 37 workspace checks, 23 inspector/connection checks, 8 save/recovery scenarios (`check-phase1-save.cjs --browser`, excluding its duplicate outer summary), 5 provider-capability checks, 9 update-page checks and 6 MCP graph checks. All 105 passed. The final 23 + 8 rerun includes a guard that hides inspector controls for stale selected IDs and screenshots for save failure, blocked return and index recovery.

The save test now checks the shared short label `保存失败`, a nonempty error explanation and a visible retry button. It retains the original durable-content, queued-save, failed-navigation and explicit index-recovery assertions. Provider/update success responses are offline fixtures; live credentials, paid generation and a real program installation or rollback were not exercised.

Integrated result logs, actual counts, timestamps and screenshot folders are indexed in `app/test-output/integration-ui-20261019/SUMMARY.md` and `summary.json`, with focused final reruns in `integration-ui-20261019-final`. The performance figures above remain the scoped isolated-branch measurements under shared host load.
