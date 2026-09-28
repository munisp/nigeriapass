# NigerianPass Onboarding PWA — Design Brainstorm

## Response 1
<response>
<text>
**Design Movement:** Nigerian Modernism — Afrofuturism meets Government Precision
**Core Principles:**
- Deep forest green + warm gold palette evoking Nigerian national identity and trust
- Asymmetric split-panel layouts: left dark sidebar with vertical navigation, right content area with generous white space
- Heavy typographic hierarchy — bold display numerals for step indicators, clean sans-serif for body
- Document-first UI: every form step feels like filling a structured official form, not a consumer app

**Color Philosophy:** Deep forest green (#0A3D2B) as the authority color — serious, trustworthy, Nigerian. Warm gold (#D4A017) as the accent — progress, achievement, completion. Off-white (#F8F6F1) as the canvas — paper-like, official.

**Layout Paradigm:** Persistent left sidebar (120px collapsed, 240px expanded) with step-by-step wizard content on the right. Each step occupies the full right panel. No cards — full-bleed sections.

**Signature Elements:**
- Green diagonal stripe header bar with gold NigerianPass wordmark
- Step indicators as large outlined numerals (01, 02, 03...) in the sidebar
- Document upload zones styled as official form fields with dashed green borders

**Interaction Philosophy:** Every action has a deliberate confirmation. Progress is always visible. Errors are inline, never modal.

**Animation:** Slide-in from right on step advance, slide-out to left on back. Subtle fade for status changes.

**Typography System:** DM Serif Display (headings) + Inter (body). Step numbers in Bebas Neue.
</text>
<probability>0.08</probability>
</response>

## Response 2
<response>
<text>
**Design Movement:** Brutalist Civic Tech — raw, honest, functional
**Core Principles:**
- High contrast black + electric green (#00FF88) on white
- Grid-based but deliberately broken — elements bleed out of containers
- Monospace typography throughout — feels like a terminal, a system, infrastructure
- Zero decorative elements — every pixel serves a function

**Color Philosophy:** Black (#0D0D0D) + electric green (#00FF88) + white. The green is the only color — used exclusively for active states, progress, and success.

**Layout Paradigm:** Full-width horizontal step bar at top. Content in a centered 720px column. No sidebar.

**Signature Elements:**
- Thick 3px black borders on all inputs
- Step completion shown as filled black squares
- Upload zones as large bordered rectangles with monospace labels

**Interaction Philosophy:** Instant feedback. No loading spinners — skeleton states only. Every field validates on blur.

**Animation:** None except for a 150ms border color transition on focus.

**Typography System:** JetBrains Mono throughout at varying weights.
</text>
<probability>0.06</probability>
</response>

## Response 3
<response>
<text>
**Design Movement:** Premium Civic — Lagos Business District meets Swiss Design System
**Core Principles:**
- Warm slate navy (#1B2B4B) as the primary authority color with crisp white content areas
- Multi-portal layout: distinct visual identity per portal (Driver, Vehicle, Fleet, Device, Admin) via accent color shifts
- Step wizard with floating progress card — always visible, never intrusive
- Glassmorphism panels for status cards; solid forms for data entry

**Color Philosophy:** Navy (#1B2B4B) = authority and trust. Emerald (#059669) = verified/success. Amber (#D97706) = pending/review. Crimson (#DC2626) = rejected/alert. Each portal gets a tinted sidebar.

**Layout Paradigm:** Fixed left sidebar (260px) with portal switcher at top, main content area with a sticky top progress bar. Forms use a two-column grid on desktop, single column on mobile.

**Signature Elements:**
- Animated circular progress ring for KYC completion score
- Document upload with real-time OCR preview panel
- Device health cards with live pulse animation for heartbeat

**Interaction Philosophy:** Progressive disclosure — show only what's needed for the current step. Inline validation with green checkmarks. Smooth accordion reveals.

**Animation:** Framer Motion page transitions (opacity + y-axis slide). Staggered list animations for document items and device cards.

**Typography System:** Sora (headings, bold, geometric) + Nunito Sans (body, friendly but professional). Numbers in tabular figures.
</text>
<probability>0.09</probability>
</response>

---
**Selected: Response 3 — Premium Civic (Lagos Business District meets Swiss Design System)**
- Multi-portal with accent color shifts per section
- Sora + Nunito Sans typography
- Navy + Emerald/Amber/Crimson semantic palette
- Framer Motion transitions
- Glassmorphism status cards + solid data entry forms
