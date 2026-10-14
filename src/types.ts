/** core types, SoundCloud RPC */

/** currently playing track */
export interface TrackInfo {
    title: string;
    /** artist */
    author: string;
    /** artwork image URL */
    artwork: string;
    /** "MM:SS" or "H:MM:SS" */
    elapsed: string;
    /** "MM:SS" or "H:MM:SS" */
    duration: string;
    isPlaying: boolean;
    /** liked by user */
    isLiked: boolean;
    /** SoundCloud URL */
    url: string;
}

/** data for Last.fm scrobbling */
export interface LastFmTrackData {
    title: string;
    /** artist */
    author: string;
    duration: string;
    /** "MM:SS" or "H:MM:SS" */
    elapsed: string;
}

/** data sent to webhooks */
export interface WebhookTrackData extends LastFmTrackData {
    /** SoundCloud URL */
    url: string;
    /** artwork image URL */
    artwork: string;
}

/** parsed artist and track name */
export interface ParsedTrackInfo {
    /** null if not found */
    artist: string | null;
    track: string;
}

/** normalized track info for display */
export interface NormalizedTrackInfo {
    /** never null, default "Unknown Artist" */
    artist: string;
    /** never null, default "Unknown Track" */
    track: string;
}

/** track state change reasons */
export type TrackUpdateReason = 'playback-state-change' | 'track-change' | 'seek-change' | 'initial-state';

/** renderer to main, track updates */
export interface TrackUpdateMessage {
    data: TrackInfo;
    reason: TrackUpdateReason;
}
