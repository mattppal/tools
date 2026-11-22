import { type ReactNode, useState } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../src/kit/tooltip.tsx";
import styles from "./nutrition.module.css";

const HOVER_DELAY_MS = 150;

type InspectProps = { tip: ReactNode; className?: string; children: ReactNode; "data-status"?: string };

export function Inspect({ tip, className, children, ...data }: InspectProps) {
	const [open, setOpen] = useState(false);
	return (
		<Tooltip open={open} onOpenChange={setOpen}>
			<TooltipTrigger
				delay={HOVER_DELAY_MS}
				closeOnClick={false}
				render={<div tabIndex={0} className={`${styles.inspect} ${className ?? ""}`} {...data} />}
				onPointerUp={(event) => {
					if (event.pointerType === "touch") setOpen((shown) => !shown);
				}}
			>
				{children}
			</TooltipTrigger>
			<TooltipPopup side="top" sideOffset={6} collisionPadding={8} className={styles.tip}>
				{tip}
			</TooltipPopup>
		</Tooltip>
	);
}

export function TipLines({ lines }: { lines: (string | null)[] }) {
	return (
		<span className={styles.tipLines}>
			{lines
				.filter((line) => line !== null)
				.map((line, index) => (
					<span key={line} className={index === 0 ? styles.tipHead : undefined}>
						{line}
					</span>
				))}
		</span>
	);
}
