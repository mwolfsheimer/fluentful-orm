export type PathSegment = string | number;

const pathBrand = Symbol('documentPath');
const referenceBrand = Symbol('attributeReference');

/** An explicit DynamoDB document path. Strings passed without this wrapper remain literal names. */
export interface DocumentPath<TValue = unknown, TSegments extends readonly PathSegment[] = readonly PathSegment[]> {
    readonly [pathBrand]: true;
    readonly segments: TSegments;
    readonly valueType?: TValue;
}

/** A stored attribute operand, never a supplied expression value. */
export interface AttributeReference<TValue = unknown> {
    readonly [referenceBrand]: true;
    readonly segments: readonly PathSegment[];
    readonly valueType?: TValue;
}

export type AttributePath = string | DocumentPath;

export function pathKey(attribute: AttributePath): string {
    return JSON.stringify(pathSegments(attribute));
}

export function pathsOverlap(first: AttributePath, second: AttributePath): boolean {
    const left = pathSegments(first), right = pathSegments(second);
    return left.slice(0, Math.min(left.length, right.length)).every((segment, index) => segment === right[index]);
}

export function uniquePaths(attributes: readonly AttributePath[]): AttributePath[] {
    if (attributes.length === 0 || attributes.some(attribute => typeof attribute === 'string' && attribute.length === 0)) throw new Error('Projection requires at least one attribute');
    const unique = [...new Map(attributes.map(attribute => [pathKey(attribute), attribute])).values()];
    if (unique.some((attribute, index) => unique.slice(index + 1).some(other => pathsOverlap(attribute, other)))) {
        throw new Error('Overlapping projection paths');
    }
    return unique;
}

function validateSegments(segments: readonly PathSegment[]): void {
    if (segments.length === 0 || typeof segments[0] !== 'string') throw new Error('A document path must start with an attribute name');
    if (segments.length > 33) throw new Error('A document path supports at most 32 dereferences');
    for (const segment of segments) {
        if (typeof segment === 'string' ? segment.length === 0 : typeof segment !== 'number' || !Number.isSafeInteger(segment) || segment < 0) {
            throw new Error('Invalid document path segment');
        }
    }
}

/** Creates an immutable path from map names and non-negative list positions. */
export function path<const TSegments extends readonly PathSegment[]>(...segments: TSegments): DocumentPath<unknown, TSegments> {
    validateSegments(segments);
    return Object.freeze({[pathBrand]: true as const, segments: Object.freeze([...segments]) as unknown as TSegments});
}

/** Creates an immutable reference to a stored field. */
export function ref(...segments: PathSegment[]): AttributeReference {
    validateSegments(segments);
    return Object.freeze({[referenceBrand]: true as const, segments: Object.freeze([...segments])});
}

export function isDocumentPath(value: unknown): value is DocumentPath {
    return typeof value === 'object' && value !== null && (value as DocumentPath)[pathBrand] === true;
}

export function isAttributeReference(value: unknown): value is AttributeReference {
    return typeof value === 'object' && value !== null && (value as AttributeReference)[referenceBrand] === true;
}

export function pathSegments(attribute: AttributePath): readonly PathSegment[] {
    if (typeof attribute === 'string') {
        validateSegments([attribute]);
        return [attribute];
    }
    if (!isDocumentPath(attribute)) throw new Error('Expected an attribute name or document path');
    validateSegments(attribute.segments);
    return attribute.segments;
}