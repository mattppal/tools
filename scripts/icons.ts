import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";

type Rgba = [number, number, number, number];
type Image = { width: number; height: number; pixels: Float32Array };
type Icon = { file: string; size: number; background?: string; logoHeight: number };
type Tap = { index: number; weight: number };
type Bounds = { x: number; y: number; width: number; height: number };

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = "src/assets/logo.png";

const ICONS: Icon[] = [
	{ file: "favicon-16.png", size: 16, logoHeight: 1 },
	{ file: "favicon-32.png", size: 32, logoHeight: 1 },
	{ file: "icon-192.png", size: 192, logoHeight: 1 },
	{ file: "icon-512.png", size: 512, logoHeight: 1 },
	{ file: "icon-maskable-512.png", size: 512, background: "#1a1917", logoHeight: 0.62 },
	{ file: "apple-touch-icon.png", size: 180, background: "#1a1917", logoHeight: 0.64 },
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as const;
type ColorType = keyof typeof CHANNELS;

function isColorType(value: number): value is ColorType {
	return value in CHANNELS;
}

function hexColor(hex: string): Rgba {
	const digits = /^#([0-9a-f]{6})$/i.exec(hex)?.[1];
	if (digits === undefined) throw new Error(`background "${hex}" must be a #rrggbb color`);
	const channel = (offset: number) => Number.parseInt(digits.slice(offset, offset + 2), 16);
	return [channel(0), channel(2), channel(4), 255];
}

function sampleReader(colorType: ColorType, palette: Buffer | undefined, transparency: Buffer | undefined): (sample: Uint8Array) => Rgba {
	switch (colorType) {
		case 0:
			return ([gray = 0]) => [gray, gray, gray, 255];
		case 2:
			return ([red = 0, green = 0, blue = 0]) => [red, green, blue, 255];
		case 3: {
			if (palette === undefined) throw new Error(`${SOURCE}: palette PNG has no PLTE chunk`);
			return ([entry = 0]) => [palette[entry * 3] ?? 0, palette[entry * 3 + 1] ?? 0, palette[entry * 3 + 2] ?? 0, transparency?.[entry] ?? 255];
		}
		case 4:
			return ([gray = 0, alpha = 0]) => [gray, gray, gray, alpha];
		case 6:
			return ([red = 0, green = 0, blue = 0, alpha = 0]) => [red, green, blue, alpha];
		default: {
			const never: never = colorType;
			return never;
		}
	}
}

function predict(filter: number, left: number, up: number, corner: number): number {
	switch (filter) {
		case 0:
			return 0;
		case 1:
			return left;
		case 2:
			return up;
		case 3:
			return (left + up) >> 1;
		case 4: {
			const estimate = left + up - corner;
			const [toLeft, toUp, toCorner] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)];
			if (toLeft <= toUp && toLeft <= toCorner) return left;
			return toUp <= toCorner ? up : corner;
		}
		default:
			throw new Error(`${SOURCE}: unknown PNG row filter ${filter}`);
	}
}

function decode(file: Buffer): Image {
	if (!file.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${SOURCE} is not a PNG`);
	const chunks = new Map<string, Buffer[]>();
	for (let offset = 8; offset + 8 <= file.length; ) {
		const length = file.readUInt32BE(offset);
		const type = file.toString("ascii", offset + 4, offset + 8);
		chunks.set(type, [...(chunks.get(type) ?? []), file.subarray(offset + 8, offset + 8 + length)]);
		offset += length + 12;
	}
	const header = chunks.get("IHDR")?.[0];
	if (header === undefined) throw new Error(`${SOURCE} has no IHDR chunk`);
	const [width, height, depth, colorType, interlace] = [header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9] ?? -1, header[12]];
	if (depth !== 8 || interlace !== 0 || !isColorType(colorType)) {
		throw new Error(`${SOURCE} must be an 8-bit, non-interlaced PNG (bit depth ${depth}, color type ${colorType}, interlace ${interlace}); re-export it as 8-bit RGBA`);
	}
	const transparency = chunks.get("tRNS")?.[0];
	if (transparency !== undefined && colorType !== 3) throw new Error(`${SOURCE} uses tRNS color-key transparency; re-export it as 8-bit RGBA`);
	const read = sampleReader(colorType, chunks.get("PLTE")?.[0], transparency);
	const channels = CHANNELS[colorType];
	const stride = width * channels;
	const raw = inflateSync(Buffer.concat(chunks.get("IDAT") ?? []));
	const bytes = new Uint8Array(height * stride);
	for (let row = 0; row < height; row++) {
		const filter = raw[row * (stride + 1)] ?? 0;
		for (let index = 0; index < stride; index++) {
			const at = row * stride + index;
			const left = index >= channels ? bytes[at - channels]! : 0;
			const up = row > 0 ? bytes[at - stride]! : 0;
			const corner = row > 0 && index >= channels ? bytes[at - stride - channels]! : 0;
			bytes[at] = (raw[row * (stride + 1) + 1 + index]! + predict(filter, left, up, corner)) & 255;
		}
	}
	const pixels = new Float32Array(width * height * 4);
	for (let pixel = 0; pixel < width * height; pixel++) {
		const [red, green, blue, alpha] = read(bytes.subarray(pixel * channels, (pixel + 1) * channels));
		pixels.set([(red * alpha) / 65025, (green * alpha) / 65025, (blue * alpha) / 65025, alpha / 255], pixel * 4);
	}
	return { width, height, pixels };
}

function lanczos(x: number): number {
	if (x === 0) return 1;
	if (Math.abs(x) >= 3) return 0;
	const angle = Math.PI * x;
	return (3 * Math.sin(angle) * Math.sin(angle / 3)) / (angle * angle);
}

function taps(source: number, target: number, scale: number, offset: number): Tap[][] {
	const spread = Math.max(1, 1 / scale);
	return Array.from({ length: target }, (_, position) => {
		const center = (position + 0.5 - offset) / scale - 0.5;
		const kernel: Tap[] = [];
		let total = 0;
		for (let tap = Math.ceil(center - 3 * spread); tap <= Math.floor(center + 3 * spread); tap++) {
			const weight = lanczos((tap - center) / spread);
			total += weight;
			if (tap >= 0 && tap < source) kernel.push({ index: tap, weight });
		}
		return kernel.map(({ index, weight }) => ({ index, weight: weight / total }));
	});
}

function resample(image: Image, size: number, scale: number, left: number, top: number): Image {
	const wide = new Float32Array(size * image.height * 4);
	taps(image.width, size, scale, left).forEach((kernel, x) => {
		for (let y = 0; y < image.height; y++) {
			for (const { index, weight } of kernel) {
				for (let channel = 0; channel < 4; channel++) wide[(y * size + x) * 4 + channel]! += image.pixels[(y * image.width + index) * 4 + channel]! * weight;
			}
		}
	});
	const pixels = new Float32Array(size * size * 4);
	taps(image.height, size, scale, top).forEach((kernel, y) => {
		for (const { index, weight } of kernel) {
			for (let x = 0; x < size; x++) {
				for (let channel = 0; channel < 4; channel++) pixels[(y * size + x) * 4 + channel]! += wide[(index * size + x) * 4 + channel]! * weight;
			}
		}
	});
	for (let pixel = 0; pixel < size * size; pixel++) {
		const alpha = pixels[pixel * 4 + 3]!;
		const kept = Math.min(1, Math.max(0, alpha));
		for (let channel = 0; channel < 3; channel++) pixels[pixel * 4 + channel] = alpha > 0 ? Math.min(1, Math.max(0, pixels[pixel * 4 + channel]! / alpha)) * kept : 0;
		pixels[pixel * 4 + 3] = kept;
	}
	return { width: size, height: size, pixels };
}

function bounds(image: Image): Bounds {
	let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
	for (let row = 0; row < image.height; row++) {
		for (let column = 0; column < image.width; column++) {
			if (image.pixels[(row * image.width + column) * 4 + 3] === 0) continue;
			[minX, maxX, minY, maxY] = [Math.min(minX, column), Math.max(maxX, column), Math.min(minY, row), Math.max(maxY, row)];
		}
	}
	if (minX === Infinity) throw new Error(`${SOURCE} has no visible pixels`);
	return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function render(logo: Image, content: Bounds, icon: Icon): Image {
	const { size } = icon;
	const canvas: Image = { width: size, height: size, pixels: new Float32Array(size * size * 4) };
	if (icon.background !== undefined) {
		const [red, green, blue] = hexColor(icon.background);
		for (let pixel = 0; pixel < size * size; pixel++) canvas.pixels.set([red / 255, green / 255, blue / 255, 1], pixel * 4);
	}
	const scale = Math.min((icon.logoHeight * size) / content.height, size / content.width);
	const left = size / 2 - (content.x + content.width / 2) * scale;
	const top = size / 2 - (content.y + content.height / 2) * scale;
	const placed = resample(logo, size, scale, left, top);
	for (let pixel = 0; pixel < size * size; pixel++) {
		const cover = 1 - placed.pixels[pixel * 4 + 3]!;
		for (let channel = 0; channel < 4; channel++) canvas.pixels[pixel * 4 + channel] = placed.pixels[pixel * 4 + channel]! + canvas.pixels[pixel * 4 + channel]! * cover;
	}
	return canvas;
}

function straight(image: Image): Uint8Array {
	const rgba = new Uint8Array(image.pixels.length);
	for (let pixel = 0; pixel < image.width * image.height; pixel++) {
		const alpha = image.pixels[pixel * 4 + 3]!;
		const opacity = Math.round(alpha * 255);
		for (let channel = 0; channel < 3; channel++) rgba[pixel * 4 + channel] = opacity === 0 ? 0 : Math.round((image.pixels[pixel * 4 + channel]! / alpha) * 255);
		rgba[pixel * 4 + 3] = opacity;
	}
	return rgba;
}

function scanlines(rgba: Uint8Array, width: number, height: number): Buffer {
	const stride = width * 4;
	const lines = Buffer.alloc(height * (stride + 1));
	const candidate = new Uint8Array(stride);
	for (let row = 0; row < height; row++) {
		let best = Infinity;
		for (let filter = 0; filter <= 4; filter++) {
			let score = 0;
			for (let index = 0; index < stride; index++) {
				const at = row * stride + index;
				const left = index >= 4 ? rgba[at - 4]! : 0;
				const up = row > 0 ? rgba[at - stride]! : 0;
				const corner = row > 0 && index >= 4 ? rgba[at - stride - 4]! : 0;
				const value = (rgba[at]! - predict(filter, left, up, corner)) & 255;
				candidate[index] = value;
				score += Math.min(value, 256 - value);
			}
			if (score >= best) continue;
			best = score;
			lines[row * (stride + 1)] = filter;
			lines.set(candidate, row * (stride + 1) + 1);
		}
	}
	return lines;
}

function chunk(type: string, data: Uint8Array): Buffer {
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const frame = Buffer.alloc(body.length + 8);
	frame.writeUInt32BE(data.length, 0);
	body.copy(frame, 4);
	frame.writeUInt32BE(crc32(body), body.length + 4);
	return frame;
}

function png(image: Image): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(image.width, 0);
	header.writeUInt32BE(image.height, 4);
	header.set([8, 6, 0, 0, 0], 8);
	const lines = scanlines(straight(image), image.width, image.height);
	return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(lines, { level: 9 })), chunk("IEND", new Uint8Array())]);
}

const logo = decode(await readFile(resolve(ROOT, SOURCE)));
const content = bounds(logo);
const outputs = ICONS.map((icon) => ({ icon, file: png(render(logo, content, icon)) }));
for (const { icon, file } of outputs) {
	await writeFile(resolve(ROOT, "public", icon.file), file);
	console.log(`public/${icon.file}  ${icon.size}x${icon.size}  ${(file.length / 1024).toFixed(1)} kB`);
}
