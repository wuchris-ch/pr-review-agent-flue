/** One source line the model may cite, with the location the application resolved for it. */
export interface SourceAnchor {
  id: string;
  file: string;
  line: number;
  side: 'base' | 'head';
  text: string;
  /** True when a finding may point at this line as the defect itself. */
  target: boolean;
}

export interface EvidenceHunk {
  text: string;
  anchors: SourceAnchor[];
}

export interface EvidenceFile {
  path: string;
  text: string;
  hunks: EvidenceHunk[];
}

/** One message worth of diff, plus the anchors a reply is allowed to cite. */
export interface EvidencePacket {
  text: string;
  anchors: ReadonlyMap<string, SourceAnchor>;
  targets: ReadonlySet<string>;
  retrievedHunks: number;
}
