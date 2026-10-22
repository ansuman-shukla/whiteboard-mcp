export const INSTRUCTIONS = `Live Excalidraw whiteboard shared with the human: you draw, they watch in a browser tab, and they can draw back or leave notes. Use it whenever a picture explains better than text: architecture, request/data flows, sequences, state machines, data structures, comparisons, plans. Call canvas_guide once before your first drawing. Then canvas_open, and draw step by step with several small canvas_draw calls while narrating briefly in chat. When the human mentions the canvas, or a result says they changed something, call canvas_read to see their edits and notes.`;

export const GUIDE = `# Explaining on the live canvas

## Loop
1. canvas_open once. Plan: 3-8 boxes beat 30.
2. Draw in steps: one canvas_draw per idea (components, then flow, then notes), each followed by a sentence or two in chat that points at the canvas ("the blue boxes are services"). Keep chat short; the canvas carries the detail.
3. canvas_focus {ids, highlight:true} to point at what you are talking about.
4. canvas_screenshot once after the main layout to check overlaps and cut-off text.
5. When the human says they drew or wrote something, canvas_read lists their changes and notes.

## Elements
- Short stable ids ("api", "db"). Re-sending an id updates only the fields you pass: move/restyle instead of redrawing.
- rectangle = component, ellipse = start/end/actor, diamond = decision, text = titles/notes, frame = zone (set "frame" on children).
- Words in shapes go in "label"; "text" is for free text.
- Arrows: {"type":"arrow","from":"api","to":"db","label":"SQL"} bind to shapes and follow them. strokeStyle "dashed" for async/optional.

## Size and spacing
- Shapes 160x80, wider for long labels (~10px/char at fontSize 20); diamonds ~1.5x wider.
- 60-100px gaps between connected shapes; 200px+ between separate diagrams.
- fontSize >= 16, titles 28-36. Snap x/y to multiples of 20.

## Layout
- Flows/pipelines: left to right. Hierarchies: top down, parents centred.
- Architecture: frames for zones (client / backend / data), traffic left to right.
- Sequences: actors in a row, labelled arrows going down in time order (or canvas_mermaid).
- Options/before-after: side by side, a title above each.
- Adding to an existing scene: canvas_read first, use free space.

## Colour (palette name or hex)
2-4 colours per diagram, each with a meaning. blue: main path/components; green: success, outputs; orange/yellow: attention, queues, in progress; red: errors, risks, removals; violet/grape: external systems, actors; teal/cyan: storage, infra; gray: context; black: text and lines. Light fills (fillStyle "solid") with dark text read best; roughness 0 = clean, 1 = sketchy.

## Mermaid
canvas_mermaid suits sequence diagrams and quick flowcharts (needs an open viewer). Hand-placed canvas_draw looks better for architecture.`;
