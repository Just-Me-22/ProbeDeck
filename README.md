# ProbeDeck

A diagnostics panel that lives inside Discord, for people writing themes and plugins for
it. Seventeen lenses, all idle until you open the panel.

It exists because the normal loop for this work is slow. You change a selector, rebuild,
reload, wait fifteen seconds, and find out you guessed wrong. Most of what is here is
aimed at getting the answer before the rebuild instead of after it.

This is a working instrument rather than a finished product. Some of it is shaped around
the setup it was built on, and the section at the bottom says which parts.

## Installing

You need an Equicord or Vencord source build. From the root of that checkout:

```bash
git clone https://github.com/Just-Me-22/ProbeDeck src/userplugins/probeDeck
pnpm build
```

Reload Discord and turn on **ProbeDeck**.

## Getting around

**F9** opens and closes it. **F10** clears what it has collected and puts the panel back
in the corner. Once it is open, click a tab, press a number from 1 to 9, or use the left
and right arrows.

The lenses that take a query put the caret straight in the box, which means the box owns
the arrows and the digits and there is no key left to change lens with. Tab is that key:
it steps to the next lens, Shift+Tab to the previous, and it keeps whatever you had typed.

`Ctrl+Alt+P` and `Ctrl+Alt+R` still work. F keys are the better choice because they carry
no character, so Windows never runs them through its AltGr translation and nothing can
leak into the message box behind the panel. The exception is if something else on your
machine already owns F9: dictation tools and macro apps like it, and a global hotkey wins
before Discord ever sees the key. If pressing F9 does something unexpected, use
`Ctrl+Alt+P`.

**hold**, next to the copy button, freezes the output. `perf` and `churn` repaint twice a
second, which makes them unreadable exactly when you are trying to read a number off
them. Press it again for live. Switching lens always goes back to live, so you cannot end
up staring at stale data without noticing.

Drag the top bar to move it. The panel ignores the mouse everywhere else on purpose, so
the element inspector can see through it to what you are clicking.

## For theme work

**inspect** is the one to start with. Click any element and it prints the box chain, the
layout its parent is applying, and what is covering it. Above all that it hands you
**ready to paste selectors** for the element and its ancestors, with the build hash
already stripped and a live match count on each, so you can tell at a glance whether one
is specific enough.

It also names which rule won each property and, more usefully, **the rules that lost**,
with the value each one wanted and why it lost, whether that is specificity, order or a
missing `!important`. The losing rule is usually your own line, and the reason is what
tells you which part to change.

Underneath that is every **custom property that reaches the element**, resolved at that
point rather than globally. Most of a Discord theme lives in variables and there is
nowhere else that shows you which ones actually arrive.

Every inspect dump also carries a **contrast** reading for the clicked element: the text
colour against whatever actually paints behind it, found by walking up past the
transparent ancestors rather than comparing against a see-through parent and reporting
nonsense. The threshold it checks against moves with font size and weight, so it names
the right target and tells you how far over or under you are. This is the white text on a
white background class of bug, caught before you ship it.

**css** is a live scratchpad. Type a rule, press Ctrl+Enter, and it applies immediately.
No build and no reload. It then reads back what the browser actually accepted and tells
you how many elements each selector matched, which catches the two usual dead ends: a rule
silently rejected over a brace, and a selector that matches nothing at all. Nothing here
survives a reload, which is the point.

**cost** with an empty box ranks the whole page. It collects every selector that has
loaded, triages them on shape, times the worst forty properly, and lists them worst first
with the stylesheet each came from. That last column is the point: it tells you where to
go and fix it. Give it a selector instead and it does the same for that one alone.

Your themes are in that ranking even though Equicord loads them over `vencord://`, which
counts as a different origin and normally hides their rules. The lens reads the files over
Equicord's own file API instead. The first sweep runs before they arrive, so it says so and
repaints once they are in. Remote themes served from a URL stay out of reach, and the lens
names every sheet it could not read rather than quietly leaving it out of the total.

**audit** sweeps for overlapping panels and seams.

**diff** watches a set of landmark selectors and tells you which class names changed, which
is what you want after Discord ships an update and half your theme stops applying.

## For plugin work

**find** searches every webpack module for words they must all contain.

**props** is the same question `findByProps` asks. Name the properties a module has to
expose and it lists what matches, ending with the `findByPropsLazy(...)` call ready to
paste.

**intl** goes the other way. Give it text you can see in Discord and it finds the message
key behind it, which is what a patch has to anchor on: the key is stable across builds
and the English is not.

**regex** is a patch tester. Give it a find string and a regex and it tells you how many
modules the find matches, how many times the regex hits in each, and what the capture
groups hold. A count of zero or of two or more is the reason most patches quietly fail.
Add a third part and it shows you what the rewritten source would say:

```
<find> | <regex> | <replacement>
```

**rest** taps the requests Discord's own client makes: method, path, body, status and
duration, newest first, filterable. This is usually faster than reading Discord's source
to work out which endpoint does a thing. Click it in the UI and read the request.

**flux** taps everything Discord dispatches internally. With an empty box it ranks event
types by how often they have fired, so you can do a thing in the UI and see what it was
called. Filter to one and you get the recent payloads with their field names, which is
what you need before writing a subscription. It pairs with **rest**: one shows what leaves
the client, the other what moves inside it.

**patches** shows which registered patches have landed. **stores** searches Flux stores by
name.

## For performance

**perf** is frame timing. **tasks** records main thread blocks over a threshold you set.
**churn** watches how much DOM is being created and destroyed. **boot** shows how long each
startup milestone took.

**tasks** also says where the time went, which is the part that turns a number into
something you can act on. It splits each slow frame into named script, work before paint
that no script claimed, requestAnimationFrame callbacks, and style through layout to paint,
then ranks the listeners and callbacks by total time held rather than by the single worst
frame. A handler firing two hundred times is what ruins an app, not the one big hitch.

Read the split before the ranking. If script is a small share, no amount of staring at the
named functions will help, and a frame that is slow with no script and no paint work is
usually waiting on the compositor rather than computing anything.

## Things worth knowing

The **rest** and **flux** lenses both see message content: one in request bodies, the
other in dispatched payloads. The copy button copies the whole panel, so read it before
pasting it anywhere. Nothing is written to disk, it only lives in memory until you reload.

The **css** lens writes into a live style tag. It is for trying things, not keeping them.
Copy anything you want into your theme before you reload.

The panel is `pointer-events: none` apart from the top bar, the tabs and the query box.
That is deliberate and is what lets the inspector click through it.

## What is shaped around one setup

Honest notes for anyone else installing it:

- The landmark selectors that **diff** and **audit** watch are the ones from the theme it
  was built alongside. They are a good starting set for Discord, but they are not yours.
- The AltGr handling exists because of a Polish keyboard layout. It costs nothing if that
  is not you.
- It assumes an Equicord or Vencord source build, since half of it reads the webpack module
  table directly.

## Licence

GPL-3.0-or-later, same as Vencord.
