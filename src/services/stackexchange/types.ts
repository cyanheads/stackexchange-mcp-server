/**
 * @fileoverview Stack Exchange API v2.3 response types for raw upstream payloads.
 * All optional fields reflect real upstream sparsity — fields may be absent entirely.
 * @module services/stackexchange/types
 */

/** Wrapper around every SE API response. */
export interface SeWrapper<T> {
  /** Seconds to wait before the next request — honor when present. */
  backoff?: number;
  has_more: boolean;
  items: T[];
  quota_max: number;
  quota_remaining: number;
}

/** SE API error response (HTTP 400/500). */
export interface SeError {
  error_id: number;
  error_message: string;
  error_name: string;
}

/** A Stack Exchange question (raw upstream). */
export interface SeQuestion {
  accepted_answer_id?: number;
  answer_count: number;
  /** Present only when filter=withbody is used. */
  body?: string;
  creation_date?: number;
  /** Excerpt from search results (search endpoint only). */
  excerpt?: string;
  is_answered: boolean;
  last_activity_date?: number;
  link: string;
  owner?: SeShallowUser;
  question_id: number;
  score: number;
  tags: string[];
  title: string;
  view_count?: number;
}

/** A Stack Exchange answer (raw upstream). */
export interface SeAnswer {
  answer_id: number;
  /** Present only when filter=withbody is used. */
  body?: string;
  creation_date?: number;
  is_accepted: boolean;
  last_activity_date?: number;
  owner?: SeShallowUser;
  question_id: number;
  score: number;
}

/** Shallow user object embedded in questions/answers. */
export interface SeShallowUser {
  display_name?: string;
  link?: string;
  reputation?: number;
  user_id?: number;
  user_type?: string;
}

/** Full user profile (raw upstream). */
export interface SeUser {
  about_me?: string;
  accept_rate?: number;
  answer_count?: number;
  badge_counts?: {
    bronze?: number;
    silver?: number;
    gold?: number;
  };
  creation_date?: number;
  display_name: string;
  last_access_date?: number;
  link: string;
  location?: string;
  profile_image?: string;
  question_count?: number;
  reputation: number;
  user_id: number;
  user_type?: string;
  view_count?: number;
  website_url?: string;
}

/** Top tag entry for a user (raw upstream). */
export interface SeTopTag {
  answer_count?: number;
  answer_score?: number;
  question_count?: number;
  question_score?: number;
  tag_name: string;
}

/** Site entry from /sites endpoint (raw upstream). */
export interface SeSite {
  /** The value to pass as the `site` parameter on all other endpoints. */
  api_site_parameter: string;
  audience?: string;
  /** Raw icon or logo image URL. */
  icon_url?: string;
  launch_date?: number;
  name: string;
  site_state?: string;
  site_type?: string;
  site_url: string;
}
