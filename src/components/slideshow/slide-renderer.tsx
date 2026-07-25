import { memo, useRef, useEffect } from "react";
import type { Slide, SlideElement, SlideLayout, SlideshowTheme } from "@/types/slideshow";
import {
  Rocket,
  Brain,
  BarChart3,
  Lightbulb,
  Shield,
  Globe,
  Zap,
  Target,
  Layers,
  Code,
  Palette,
  Users,
  TrendingUp,
  Heart,
  Star,
  Settings,
  Search,
  BookOpen,
  GraduationCap,
  Briefcase,
  Database,
  Cpu,
  Wifi,
  Lock,
  Eye,
  MessageCircle,
  Calendar,
  MapPin,
  Award,
  Flag,
  Compass,
  Sparkles,
  ChevronRight,
  CheckCircle,
  ArrowRight,
  LineChart,
  PieChart,
  Monitor,
  Smartphone,
  Cloud,
  Server,
  GitBranch,
  Package,
  Feather,
  Gem,
  Crown,
  Trophy,
} from "lucide-react";
import type { LucideProps } from "lucide-react";

// ---------------------------------------------------------------------------
// SlideRenderer — renders a single slide at a given scale
// ---------------------------------------------------------------------------

const BASE_W = 960;
const BASE_H = 540;

const DEFAULT_THEME: Required<SlideshowTheme> = {
  backgroundColor: "#0f172a",
  titleColor: "#f1f5f9",
  textColor: "#94a3b8",
  accentColor: "#3b82f6",
  fontFamily: "Inter",
};

// ---------------------------------------------------------------------------
// Pre-imported icon map (reliable, no dynamic import issues)
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, React.ComponentType<LucideProps>> = {
  rocket: Rocket,
  brain: Brain,
  "bar-chart-3": BarChart3,
  lightbulb: Lightbulb,
  shield: Shield,
  globe: Globe,
  zap: Zap,
  target: Target,
  layers: Layers,
  code: Code,
  palette: Palette,
  users: Users,
  "trending-up": TrendingUp,
  heart: Heart,
  star: Star,
  settings: Settings,
  search: Search,
  "book-open": BookOpen,
  "graduation-cap": GraduationCap,
  briefcase: Briefcase,
  database: Database,
  cpu: Cpu,
  wifi: Wifi,
  lock: Lock,
  eye: Eye,
  "message-circle": MessageCircle,
  calendar: Calendar,
  "map-pin": MapPin,
  award: Award,
  flag: Flag,
  compass: Compass,
  sparkles: Sparkles,
  "chevron-right": ChevronRight,
  "check-circle": CheckCircle,
  "arrow-right": ArrowRight,
  "line-chart": LineChart,
  "pie-chart": PieChart,
  monitor: Monitor,
  smartphone: Smartphone,
  cloud: Cloud,
  server: Server,
  "git-branch": GitBranch,
  package: Package,
  feather: Feather,
  gem: Gem,
  crown: Crown,
  trophy: Trophy,
};

function getIcon(name: string): React.ComponentType<LucideProps> | null {
  return ICON_MAP[name.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface SlideRendererProps {
  readonly slide: Slide;
  readonly theme?: SlideshowTheme;
  readonly scale?: number;
  readonly onElementClick?: (
    elementIndex: number,
    element: SlideElement,
    subIndex?: number,
  ) => void;
  readonly selectedElementIndex?: number;
  readonly selectedSubIndex?: number;
  // Inline editing
  readonly onElementDoubleClick?: (
    elementIndex: number,
    element: SlideElement,
    subIndex?: number,
  ) => void;
  readonly editingElementIndex?: number;
  readonly editingSubIndex?: number;
  readonly onEditCommit?: (elementIndex: number, newText: string, subIndex?: number) => void;
  readonly onEditCancel?: () => void;
}

export const SlideRenderer = memo(function SlideRenderer({
  slide,
  theme,
  scale = 1,
  onElementClick,
  selectedElementIndex,
  selectedSubIndex,
  onElementDoubleClick,
  editingElementIndex,
  editingSubIndex,
  onEditCommit,
  onEditCancel,
}: SlideRendererProps) {
  const t = { ...DEFAULT_THEME, ...theme };

  const vars = {
    "--slide-bg": t.backgroundColor,
    "--slide-title": t.titleColor,
    "--slide-text": t.textColor,
    "--slide-accent": t.accentColor,
    "--slide-font": t.fontFamily,
  } as React.CSSProperties;

  const isCentered = slide.layout === "title" || slide.layout === "section";

  return (
    <div
      style={{
        ...vars,
        width: BASE_W * scale,
        height: BASE_H * scale,
        overflow: "hidden",
        borderRadius: 4 * scale,
        position: "relative",
        flexShrink: 0,
      }}
    >
      {/* Background layer */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            slide.imageKeyword && isCentered
              ? buildGradientBg(t.backgroundColor, t.accentColor, slide.layout)
              : t.backgroundColor,
        }}
      />

      {/* Decorative elements */}
      <SlideDecorations layout={slide.layout} hasImageBg={!!slide.imageKeyword && isCentered} />

      {/* Content */}
      <div
        style={{
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          width: BASE_W,
          height: BASE_H,
          position: "relative",
          zIndex: 2,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxSizing: "border-box",
          ...(isCentered
            ? {
                justifyContent: "center",
                alignItems: "center",
                padding: "56px 80px",
                gap: 14,
                textAlign: "center" as const,
              }
            : slide.layout === "two-column"
              ? { padding: "52px 56px", gap: 20 }
              : { padding: "52px 56px", gap: 16 }),
        }}
      >
        {/* Icon for centered layouts */}
        {slide.icon && isCentered && <SlideIcon name={slide.icon} layout={slide.layout} />}

        {/* Content elements */}
        {slide.elements && slide.elements.length > 0
          ? slide.layout === "two-column"
            ? renderTwoColumn(
                slide.elements,
                slide.icon,
                onElementClick,
                selectedElementIndex,
                selectedSubIndex,
                onElementDoubleClick,
                editingElementIndex,
                editingSubIndex,
                onEditCommit,
                onEditCancel,
              )
            : slide.elements.map((el, i) =>
                onElementClick ? (
                  el.type === "bullets" && el.items ? (
                    /* Bullets: each item individually clickable */
                    <div
                      key={i}
                      style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}
                    >
                      {el.items.map((item, j) => (
                        <ClickableElementWrapper
                          key={j}
                          isSelected={selectedElementIndex === i && selectedSubIndex === j}
                          onClick={() => onElementClick(i, el, j)}
                          onDoubleClick={
                            onElementDoubleClick ? () => onElementDoubleClick(i, el, j) : undefined
                          }
                        >
                          {editingElementIndex === i &&
                          editingSubIndex === j &&
                          onEditCommit &&
                          onEditCancel ? (
                            <BulletItem
                              item={item}
                              isEditing
                              onCommit={(t) => onEditCommit(i, t, j)}
                              onCancel={onEditCancel}
                            />
                          ) : (
                            <BulletItem item={item} />
                          )}
                        </ClickableElementWrapper>
                      ))}
                    </div>
                  ) : (
                    <ClickableElementWrapper
                      key={i}
                      isSelected={selectedElementIndex === i}
                      onClick={() => onElementClick(i, el)}
                      onDoubleClick={
                        onElementDoubleClick ? () => onElementDoubleClick(i, el) : undefined
                      }
                    >
                      {editingElementIndex === i &&
                      editingSubIndex == null &&
                      onEditCommit &&
                      onEditCancel ? (
                        <ElementRenderer
                          element={el}
                          layout={slide.layout}
                          isEditing
                          onEditCommit={(t) => onEditCommit(i, t)}
                          onEditCancel={onEditCancel}
                        />
                      ) : (
                        <ElementRenderer element={el} layout={slide.layout} />
                      )}
                    </ClickableElementWrapper>
                  )
                ) : (
                  <ElementRenderer key={i} element={el} layout={slide.layout} />
                ),
              )
          : null}

        {/* Icon for content layout — bottom-right watermark */}
        {slide.icon && slide.layout === "content" && <SlideIconWatermark name={slide.icon} />}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Gradient backgrounds (replaces unreliable Unsplash)
// ---------------------------------------------------------------------------

function buildGradientBg(bg: string, accent: string, layout: SlideLayout): string {
  if (layout === "title") {
    return `
      radial-gradient(ellipse 80% 60% at 70% 80%, ${accent}25 0%, transparent 70%),
      radial-gradient(ellipse 60% 50% at 20% 30%, ${accent}15 0%, transparent 60%),
      linear-gradient(135deg, ${bg} 0%, ${adjustBrightness(bg, 1.2)} 100%)
    `;
  }
  return `
    radial-gradient(ellipse 70% 60% at 80% 60%, ${accent}18 0%, transparent 65%),
    linear-gradient(160deg, ${bg} 0%, ${adjustBrightness(bg, 1.15)} 100%)
  `;
}

function adjustBrightness(hex: string, factor: number): string {
  const c = hex.replace("#", "");
  if (c.length !== 6) return hex;
  const r = Math.min(255, Math.round(parseInt(c.slice(0, 2), 16) * factor));
  const g = Math.min(255, Math.round(parseInt(c.slice(2, 4), 16) * factor));
  const b = Math.min(255, Math.round(parseInt(c.slice(4, 6), 16) * factor));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Decorative background elements
// ---------------------------------------------------------------------------

function SlideDecorations({ layout, hasImageBg }: { layout: SlideLayout; hasImageBg: boolean }) {
  const abs = { position: "absolute" as const, pointerEvents: "none" as const };

  switch (layout) {
    case "title":
      return (
        <div style={{ ...abs, inset: 0, overflow: "hidden", zIndex: 1 }}>
          {/* Large glowing orb */}
          <div
            style={{
              position: "absolute",
              right: -100,
              bottom: -100,
              width: 500,
              height: 500,
              borderRadius: "50%",
              background: "radial-gradient(circle, var(--slide-accent) 0%, transparent 65%)",
              opacity: hasImageBg ? 0.2 : 0.1,
            }}
          />
          {/* Top-left subtle orb */}
          <div
            style={{
              position: "absolute",
              left: -80,
              top: -80,
              width: 300,
              height: 300,
              borderRadius: "50%",
              background: "radial-gradient(circle, var(--slide-accent) 0%, transparent 70%)",
              opacity: 0.06,
            }}
          />
          {/* Diagonal line accent */}
          <div
            style={{
              position: "absolute",
              right: 60,
              top: 0,
              width: 2,
              height: 120,
              background: "linear-gradient(to bottom, var(--slide-accent), transparent)",
              opacity: 0.3,
            }}
          />
          {/* Corner dots */}
          <div style={{ position: "absolute", left: 56, bottom: 40, display: "flex", gap: 8 }}>
            {[0.5, 0.35, 0.2].map((op, i) => (
              <div
                key={i}
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  backgroundColor: "var(--slide-accent)",
                  opacity: op,
                }}
              />
            ))}
          </div>
        </div>
      );

    case "section":
      return (
        <div style={{ ...abs, inset: 0, overflow: "hidden", zIndex: 1 }}>
          {/* Large ring */}
          <div
            style={{
              position: "absolute",
              right: -80,
              top: -80,
              width: 350,
              height: 350,
              borderRadius: "50%",
              border: "1.5px solid var(--slide-accent)",
              opacity: 0.1,
            }}
          />
          <div
            style={{
              position: "absolute",
              right: -40,
              top: -40,
              width: 250,
              height: 250,
              borderRadius: "50%",
              border: "1px solid var(--slide-accent)",
              opacity: 0.07,
            }}
          />
          {/* Left accent bar */}
          <div
            style={{
              position: "absolute",
              left: 0,
              top: "30%",
              width: 5,
              height: "40%",
              background:
                "linear-gradient(to bottom, transparent, var(--slide-accent), transparent)",
              opacity: 0.5,
            }}
          />
        </div>
      );

    case "content":
      return (
        <div style={{ ...abs, inset: 0, overflow: "hidden", zIndex: 1 }}>
          {/* Top accent bar */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: 3,
              background:
                "linear-gradient(90deg, var(--slide-accent), var(--slide-accent) 30%, transparent 80%)",
              opacity: 0.8,
            }}
          />
          {/* Corner decoration */}
          <div
            style={{
              position: "absolute",
              right: -40,
              top: -40,
              width: 180,
              height: 180,
              borderRadius: "50%",
              background: "radial-gradient(circle, var(--slide-accent) 0%, transparent 70%)",
              opacity: 0.06,
            }}
          />
          {/* Bottom-right subtle line */}
          <div
            style={{
              position: "absolute",
              right: 56,
              bottom: 0,
              width: 1,
              height: 60,
              background: "linear-gradient(to top, var(--slide-accent), transparent)",
              opacity: 0.2,
            }}
          />
        </div>
      );

    case "two-column":
      return (
        <div style={{ ...abs, inset: 0, overflow: "hidden", zIndex: 1 }}>
          {/* Top accent bar (dual color) */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: 3,
              background:
                "linear-gradient(90deg, var(--slide-accent) 0%, var(--slide-accent) 48%, transparent 48%, transparent 52%, var(--slide-accent) 52%, transparent 100%)",
              opacity: 0.6,
            }}
          />
          {/* Corner dots pattern */}
          <div
            style={{
              position: "absolute",
              right: 40,
              bottom: 28,
              display: "flex",
              gap: 6,
              opacity: 0.12,
            }}
          >
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: "var(--slide-accent)",
                }}
              />
            ))}
          </div>
        </div>
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Icon rendering
// ---------------------------------------------------------------------------

function SlideIcon({ name, layout }: { name: string; layout: SlideLayout }) {
  const IconComp = getIcon(name);
  if (!IconComp) return null;

  const size = layout === "title" ? 56 : 44;
  return (
    <div
      style={{
        width: size + 24,
        height: size + 24,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, var(--slide-accent)20, var(--slide-accent)08)",
        border: "1px solid var(--slide-accent)18",
        marginBottom: 8,
        flexShrink: 0,
      }}
    >
      <IconComp
        size={size}
        strokeWidth={1.3}
        style={{ color: "var(--slide-accent)", opacity: 0.7 }}
      />
    </div>
  );
}

function SlideIconWatermark({ name }: { name: string }) {
  const IconComp = getIcon(name);
  if (!IconComp) return null;

  return (
    <div
      style={{
        position: "absolute",
        right: 40,
        bottom: 32,
        zIndex: 1,
        opacity: 0.08,
        color: "var(--slide-accent)",
      }}
    >
      <IconComp size={120} strokeWidth={0.8} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clickable element wrapper (interactive preview only, not thumbnails)
// ---------------------------------------------------------------------------

function ClickableElementWrapper({
  isSelected,
  onClick,
  onDoubleClick,
  children,
}: {
  isSelected: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  children: React.ReactNode;
}) {
  // Use box-shadow for highlight — zero layout impact (no border/padding/margin/width changes)
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={
        onDoubleClick
          ? (e) => {
              e.stopPropagation();
              e.preventDefault();
              onDoubleClick();
            }
          : undefined
      }
      className="native-css-hover"
      style={
        {
          cursor: "pointer",
          borderRadius: 6,
          boxShadow: isSelected ? "0 0 0 2px var(--slide-accent)" : "none",
          backgroundColor: isSelected ? "var(--slide-accent)18" : "transparent",
          "--native-hover-bg-color": !isSelected ? "var(--slide-accent)0d" : undefined,
          "--native-hover-shadow": !isSelected ? "0 0 0 1.5px var(--slide-accent)60" : undefined,
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline editable text (contentEditable)
// ---------------------------------------------------------------------------

function EditableText({
  text,
  style,
  onCommit,
  onCancel,
}: {
  text: string;
  style: React.CSSProperties;
  onCommit: (newText: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const committed = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select all text
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    const newText = (ref.current?.textContent ?? "").trim();
    if (newText && newText !== text) {
      onCommit(newText);
    } else {
      onCancel();
    }
  };

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      style={{
        ...style,
        outline: "none",
        boxShadow: "0 0 0 2px var(--slide-accent)",
        borderRadius: 3,
        cursor: "text",
        padding: "2px 4px",
        margin: "-2px -4px",
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          committed.current = true;
          onCancel();
        }
      }}
      onBlur={commit}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Element renderers
// ---------------------------------------------------------------------------

interface EditProps {
  readonly isEditing?: boolean;
  readonly onEditCommit?: (text: string) => void;
  readonly onEditCancel?: () => void;
}

function ElementRenderer({
  element,
  layout,
  isEditing,
  onEditCommit,
  onEditCancel,
}: { element: SlideElement; layout: string } & EditProps) {
  switch (element.type) {
    case "title":
      return (
        <TitleElement
          text={element.text}
          level={element.level}
          centered={layout === "title" || layout === "section"}
          isEditing={isEditing}
          onEditCommit={onEditCommit}
          onEditCancel={onEditCancel}
        />
      );
    case "paragraph":
      return (
        <ParagraphElement
          text={element.text}
          isEditing={isEditing}
          onEditCommit={onEditCommit}
          onEditCancel={onEditCancel}
        />
      );
    case "bullets":
      return <BulletsElement items={element.items} />;
    default:
      return null;
  }
}

function TitleElement({
  text,
  level,
  centered,
  isEditing,
  onEditCommit,
  onEditCancel,
}: { text: string; level?: 1 | 2; centered?: boolean } & EditProps) {
  const isSubtitle = level === 2;

  const subtitleStyle: React.CSSProperties = {
    color: "var(--slide-text)",
    fontSize: centered ? 20 : 17,
    fontWeight: 400,
    lineHeight: 1.5,
    letterSpacing: "0.01em",
    textAlign: centered ? "center" : "left",
    width: "100%",
    opacity: 0.8,
  };

  if (isSubtitle) {
    return isEditing && onEditCommit && onEditCancel ? (
      <div style={{ width: "100%" }}>
        <EditableText
          text={text}
          style={subtitleStyle}
          onCommit={onEditCommit}
          onCancel={onEditCancel}
        />
      </div>
    ) : (
      <div style={subtitleStyle}>{text}</div>
    );
  }

  const titleStyle: React.CSSProperties = {
    color: "var(--slide-title)",
    fontSize: centered ? 40 : 26,
    fontWeight: 700,
    lineHeight: 1.2,
    letterSpacing: "-0.02em",
    textAlign: centered ? "center" : "left",
  };

  return (
    <div style={{ width: "100%" }}>
      {isEditing && onEditCommit && onEditCancel ? (
        <EditableText
          text={text}
          style={titleStyle}
          onCommit={onEditCommit}
          onCancel={onEditCancel}
        />
      ) : (
        <div style={titleStyle}>{text}</div>
      )}
      {/* Accent underline for content titles */}
      {!centered && (
        <div style={{ marginTop: 10, display: "flex", gap: 4 }}>
          <div
            style={{
              width: 32,
              height: 3,
              borderRadius: 2,
              backgroundColor: "var(--slide-accent)",
              opacity: 0.9,
            }}
          />
          <div
            style={{
              width: 8,
              height: 3,
              borderRadius: 2,
              backgroundColor: "var(--slide-accent)",
              opacity: 0.4,
            }}
          />
        </div>
      )}
    </div>
  );
}

function ParagraphElement({
  text,
  isEditing,
  onEditCommit,
  onEditCancel,
}: { text: string } & EditProps) {
  const style: React.CSSProperties = {
    color: "var(--slide-text)",
    fontSize: 16,
    lineHeight: 1.7,
    maxWidth: "90%",
  };
  return isEditing && onEditCommit && onEditCancel ? (
    <EditableText text={text} style={style} onCommit={onEditCommit} onCancel={onEditCancel} />
  ) : (
    <div style={style}>{text}</div>
  );
}

/** Single bullet item — shared by BulletsElement and clickable rendering */
function BulletItem({
  item,
  isEditing,
  onCommit,
  onCancel,
}: {
  item: { text: string; level?: number };
  isEditing?: boolean;
  onCommit?: (text: string) => void;
  onCancel?: () => void;
}) {
  const isNested = (item.level ?? 0) > 0;
  const textStyle: React.CSSProperties = {
    color: "var(--slide-text)",
    fontSize: isNested ? 14 : 15,
    lineHeight: 1.55,
    opacity: isNested ? 0.8 : 1,
  };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        paddingLeft: (item.level ?? 0) * 20,
      }}
    >
      <div
        style={{
          width: isNested ? 4 : 6,
          height: isNested ? 4 : 6,
          borderRadius: "50%",
          backgroundColor: "var(--slide-accent)",
          flexShrink: 0,
          marginTop: 8,
          opacity: isNested ? 0.4 : 0.7,
        }}
      />
      {isEditing && onCommit && onCancel ? (
        <EditableText text={item.text} style={textStyle} onCommit={onCommit} onCancel={onCancel} />
      ) : (
        <div style={textStyle}>{item.text}</div>
      )}
    </div>
  );
}

function BulletsElement({ items }: { items: readonly { text: string; level?: number }[] }) {
  if (!items) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
      {items.map((item, i) => (
        <BulletItem key={i} item={item} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Two-column layout
// ---------------------------------------------------------------------------

function renderTwoColumn(
  elements?: readonly SlideElement[],
  icon?: string,
  onElementClick?: (elementIndex: number, element: SlideElement, subIndex?: number) => void,
  selectedElementIndex?: number,
  selectedSubIndex?: number,
  onElementDoubleClick?: (elementIndex: number, element: SlideElement, subIndex?: number) => void,
  editingElementIndex?: number,
  editingSubIndex?: number,
  onEditCommit?: (elementIndex: number, newText: string, subIndex?: number) => void,
  onEditCancel?: () => void,
) {
  if (!elements) return null;

  const titleIdx = elements.findIndex((el) => el.type === "title");
  const title = titleIdx >= 0 ? elements[titleIdx] : null;

  // Track original indices so click handler reports the correct position
  const rest: Array<{ el: SlideElement; idx: number }> = [];
  elements.forEach((el, i) => {
    if (i !== titleIdx) rest.push({ el, idx: i });
  });
  const mid = Math.ceil(rest.length / 2);
  const left = rest.slice(0, mid);
  const right = rest.slice(mid);

  const isEditingEl = (idx: number, sub?: number) =>
    editingElementIndex === idx && editingSubIndex === sub;

  const renderEl = (el: SlideElement, origIdx: number) => {
    if (onElementClick && el.type === "bullets" && el.items) {
      return (
        <div
          key={origIdx}
          style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}
        >
          {el.items.map((item, j) => (
            <ClickableElementWrapper
              key={j}
              isSelected={selectedElementIndex === origIdx && selectedSubIndex === j}
              onClick={() => onElementClick(origIdx, el, j)}
              onDoubleClick={
                onElementDoubleClick ? () => onElementDoubleClick(origIdx, el, j) : undefined
              }
            >
              {isEditingEl(origIdx, j) && onEditCommit && onEditCancel ? (
                <BulletItem
                  item={item}
                  isEditing
                  onCommit={(t) => onEditCommit(origIdx, t, j)}
                  onCancel={onEditCancel}
                />
              ) : (
                <BulletItem item={item} />
              )}
            </ClickableElementWrapper>
          ))}
        </div>
      );
    }
    return onElementClick ? (
      <ClickableElementWrapper
        key={origIdx}
        isSelected={selectedElementIndex === origIdx}
        onClick={() => onElementClick(origIdx, el)}
        onDoubleClick={onElementDoubleClick ? () => onElementDoubleClick(origIdx, el) : undefined}
      >
        {isEditingEl(origIdx) && onEditCommit && onEditCancel ? (
          <ElementRenderer
            element={el}
            layout="content"
            isEditing
            onEditCommit={(t) => onEditCommit(origIdx, t)}
            onEditCancel={onEditCancel}
          />
        ) : (
          <ElementRenderer element={el} layout="content" />
        )}
      </ClickableElementWrapper>
    ) : (
      <ElementRenderer key={origIdx} element={el} layout="content" />
    );
  };

  return (
    <>
      {title && renderEl(title, titleIdx)}
      <div
        style={{
          display: "flex",
          gap: 24,
          flex: 1,
          width: "100%",
          position: "relative",
          minHeight: 0,
        }}
      >
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
          {left.map(({ el, idx }) => renderEl(el, idx))}
        </div>
        {/* Vertical divider */}
        <div
          style={{
            width: 1,
            alignSelf: "stretch",
            background: "linear-gradient(to bottom, var(--slide-accent), transparent)",
            opacity: 0.2,
          }}
        />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
          {right.map(({ el, idx }) => renderEl(el, idx))}
        </div>
      </div>
      {/* Watermark icon */}
      {icon && <SlideIconWatermark name={icon} />}
    </>
  );
}
