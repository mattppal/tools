import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import Home01Icon from "@hugeicons/core-free-icons/Home01Icon";
import Download04Icon from "@hugeicons/core-free-icons/Download04Icon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon";
import Menu01Icon from "@hugeicons/core-free-icons/Menu01Icon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/MoreHorizontalIcon";
import Note01Icon from "@hugeicons/core-free-icons/Note01Icon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import Settings02Icon from "@hugeicons/core-free-icons/Settings02Icon";
import SidebarLeftIcon from "@hugeicons/core-free-icons/SidebarLeftIcon";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

const GLYPHS = {
	plus: Add01Icon,
	back: ArrowLeft01Icon,
	"chevron-right": ArrowRight01Icon,
	open: ArrowUpRight01Icon,
	close: Cancel01Icon,
	success: CheckmarkCircle02Icon,
	install: Download04Icon,
	home: Home01Icon,
	info: InformationCircleIcon,
	alert: Alert02Icon,
	loading: Loading03Icon,
	menu: Menu01Icon,
	more: MoreHorizontalIcon,
	note: Note01Icon,
	search: Search01Icon,
	gear: Settings02Icon,
	sidebar: SidebarLeftIcon,
} as const satisfies Record<string, IconSvgElement>;

export type IconName = keyof typeof GLYPHS;

const STROKE = 1.5;

export function Icon({ name, size = 16, className }: { name: IconName; size?: 12 | 16 | 20; className?: string | undefined }) {
	return <HugeiconsIcon icon={GLYPHS[name]} size={size} strokeWidth={STROKE} absoluteStrokeWidth className={className} aria-hidden="true" />;
}
