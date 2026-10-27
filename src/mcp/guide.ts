export const INSTRUCTIONS = `Live whiteboard shown to the human beside the chat: you draw, they watch and can draw back or leave notes. Use it whenever a picture explains better than text (architecture, flows, sequences, state machines, data structures, comparisons). Each chat has its own board; call canvas_guide once, then canvas_open with a topic title, and draw step by step while narrating briefly. The tools show the board themselves; open board links they give you in your in-app browser or preview tool, never an external browser. To build on another chat's drawing (any folder), canvas_open {board}; canvas_search finds boards and saved copies (canvas_save). When the human mentions the board, call canvas_read.`;

export const GUIDE = `# Explaining on the live canvas

## Loop
1. canvas_open {title:"<topic>"} once: shows this chat's board beside the chat. Board links go in your in-app browser or preview tool. Plan: 3-8 boxes beat 30.
2. Draw in steps: one canvas_draw per idea (components, then flow, then notes), each followed by a sentence or two in chat that points at the canvas ("the blue boxes are services").
3. canvas_focus {ids, highlight:true} to point at what you discuss.
4. canvas_screenshot once after the main layout to check overlaps and cut-off text.
5. When the human says they drew or wrote something, canvas_read lists their changes and notes.
6. canvas_open lists this workspace's other boards; {board:"<title>"} opens one (any folder), {board:"own"} goes back.

## Elements
- Short stable ids ("api", "db"). Re-sending an id updates only the fields you pass: move/restyle instead of redrawing.
- rectangle = component, ellipse = start/end/actor, diamond = decision, text = titles/notes.
- Never frames. A section is a rectangle around its boxes (backgroundColor "transparent", strokeStyle "dashed", strokeColor "gray", roughness 0), its name a separate text inside its top-left; attach no children. Arrows to a whole section bind to that rectangle.
- Words in shapes go in "label", free text in "text".
- Arrows: {"type":"arrow","from":"api","to":"db","label":"SQL"} bind to shapes and follow them. strokeStyle "dashed" for async/optional.

## Size and spacing
- Shapes 160x80, wider for long labels (~10px/char at fontSize 20); diamonds ~1.5x wider.
- 60-100px gaps between connected shapes; 200px+ between separate diagrams.
- fontSize >= 16, titles 28-36. Snap x/y to multiples of 20.

## Layout
- Flows/pipelines: left to right. Hierarchies: top down, parents centred.
- Architecture: dashed sections for zones (client / backend / data), traffic left to right.
- Sequences: actors in a row, labelled arrows going down in time order, or canvas_mermaid (needs an open viewer).
- Options/before-after: side by side, a title above each.
- Adding to an existing scene: canvas_read first, use free space.

## Colour (palette name or hex)
2-4 colours per diagram, each with a meaning. blue: main path/components; green: success, outputs; orange/yellow: attention, queues, in progress; red: errors, risks, removals; violet/grape: external systems, actors; teal/cyan: storage, infra; gray: context; black: text and lines. Light fills (fillStyle "solid") with dark text read best; roughness 0 = clean, 1 = sketchy.`;
