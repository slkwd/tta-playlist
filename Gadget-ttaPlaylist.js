/* global mediaWiki, jQuery */
/**
 * TTA Playlist Gadget
 *
 * Turns a wikitext playlist definition:
 *
 *   <div class="tta-playlist" data-title="My Playlist" data-cover="File:Cover.jpg">
 *   * [[File:Track1.mp3]] // Player Name
 *   * [[File:Track2.mp3]] // Player Name
 *   <div class="tta-playlist-artworks" style="display:none">
 *     <span data-file="File:Track1.mp3" data-artwork="File:Cover1.jpg"></span>
 *     <span data-file="File:Track2.mp3" data-artwork="File:Cover2.jpg"></span>
 *   </div>
 *   </div>
 *
 * into an interactive HTML5 audio playlist with:
 *  - cover image
 *  - per-track artwork (optional)
 *  - previous/next/shuffle controls
 *  - drag & drop reordering (client-side only)
 *
 * This gadget is read-only with respect to wikitext: it does not write pages,
 * only reads the rendered HTML and builds the UI on top.
 */

( function ( mw, $ ) {
	'use strict';

	console.log( 'ttaPlaylist gadget v2.19 restored (handle-left, no-trash) + console.logs' );

	/**
	 * Collect track metadata from a `.tta-playlist` container.
	 *
	 * It parses the `<li>` items in the rendered wikitext playlist and also
	 * looks up a hidden artwork mapping from:
	 *
	 *   <div class="tta-playlist-artworks">
	 *     <span data-file="File:Track.mp3" data-artwork="File:Cover.jpg"></span>
	 *   </div>
	 *
	 * @param {jQuery} $container jQuery-wrapped `.tta-playlist` container.
	 * @return {Array<Object>} Array of track objects:
	 *  - fileTitle {string}   Normalized file title (e.g. "File:Track.mp3")
	 *  - label {string}       Full textual label from `<li>`
	 *  - title {string}       Display title for the track
	 *  - extra {string|null}  Extra info (e.g. player name after " // ")
	 *  - pretty {string}      File name without prefix and extension
	 *  - artworkTitle {string|null} Artwork file title (if any)
	 *  - artworkUrl {string|null}   Artwork URL (filled later by fetchFileUrls)
	 *  - url {string|null}          Audio URL (filled later by fetchFileUrls)
	 *  - $row {jQuery|null}         Row element in the rendered playlist UI
	 */
	function collectTracks( $container ) {
		var tracks = [];

		console.group( '[TTA] collectTracks' );

		// 1) Base track data from <li> elements
		$container.find( 'li' ).each( function () {
			var $li = $( this );
			var $link = $li.find( 'a' ).first();
			if ( !$link.length ) {
				return;
			}

			// Try to get a "File:..." style title, falling back to href
			var fileTitle = $link.attr( 'title' );
			if ( !fileTitle ) {
				var href = $link.attr( 'href' ) || '';
				var parts = href.split( '/' );
				fileTitle = decodeURIComponent( parts.pop() || '' );
			}

			// Normalize fileTitle: ensure File: prefix, underscores → spaces
			if ( fileTitle && fileTitle.indexOf( 'File:' ) !== 0 ) {
				fileTitle = 'File:' + fileTitle;
			}
			fileTitle = fileTitle.replace( /_/g, ' ' );

			if ( !fileTitle || fileTitle.indexOf( 'File:' ) !== 0 ) {
				console.log( 'SKIP LI: no valid File: title', fileTitle );
				return;
			}

			var fullText = $.trim( $li.text() || '' );
			var pretty = fileTitle
				.replace( /^File:/i, '' )
				.replace( /\.[^.]+$/, '' )
				.replace( /[_]+/g, ' ' );
			var linkLabel = $.trim( $link.text() || '' );
			var baseTitle = ( linkLabel && !/^https?:\/\//i.test( linkLabel ) ) ? linkLabel : pretty;

			// Try to extract "extra" info after the last " // "
			var sep = ' // ';
			var extra = null;
			var idx = fullText.lastIndexOf( sep );
			if ( idx !== -1 ) {
				extra = fullText.slice( idx + sep.length ).trim();
			}

			tracks.push( {
				fileTitle: fileTitle,
				label: fullText,
				title: baseTitle,
				extra: extra,
				pretty: pretty,
				artworkTitle: null,
				artworkUrl: null,
				url: null,
				$row: null
			} );
		} );

		console.log( '[TTA] collectTracks - base tracks:', tracks );

		if ( !tracks.length ) {
			console.groupEnd();
			return tracks;
		}

		// 2) Build artwork map from <div class="tta-playlist-artworks">
		var artworkMap = Object.create( null );
		var $artSpans = $container.find( '.tta-playlist-artworks span[data-file][data-artwork]' );
		console.log( '[TTA] collectTracks - found artwork spans:', $artSpans.length );

		$artSpans.each( function () {
			var $span = $( this );
			var rawFile = $span.data( 'file' );
			var rawArt = $span.data( 'artwork' );
			if ( !rawFile || !rawArt ) {
				return;
			}

			// Normalize file key as we do for fileTitle
			var fileKey = decodeURIComponent( rawFile );
			if ( fileKey.indexOf( 'File:' ) !== 0 ) {
				fileKey = 'File:' + fileKey;
			}
			fileKey = fileKey.replace( /_/g, ' ' );

			var artTitle = decodeURIComponent( rawArt );
			if ( artTitle.indexOf( 'File:' ) !== 0 ) {
				artTitle = 'File:' + artTitle;
			}

			artworkMap[ fileKey ] = artTitle;
			console.log( '[TTA] artworkMap entry:', fileKey, '→', artTitle );
		} );

		// 3) Attach artwork titles to the track list
		tracks.forEach( function ( t ) {
			if ( !t.artworkTitle && artworkMap[ t.fileTitle ] ) {
				t.artworkTitle = artworkMap[ t.fileTitle ];
			}
			console.log( '[TTA] TRACK final:', t.fileTitle, '| artworkTitle=', t.artworkTitle );
		} );

		console.groupEnd();
		return tracks;
	}

/**
 * Fetch audio file URLs and optional artwork/cover URLs.
 * Uses a normalization layer (spaces vs underscores, case) so that
 * titles coming from wikitext (data-artwork, etc.) reliably match
 * the canonical titles returned by the MediaWiki API.
 *
 * @param {Array<Object>} tracks
 * @param {string|null} coverTitle
 * @return {jQuery.Promise<{coverUrl: string|null}>}
 */
function fetchFileUrls( tracks, coverTitle ) {
    var api = new mw.Api();

    // Normalize a title into a comparison key:
    // - decode URI components
    // - replace underscores with spaces
    // - trim and lowercase
    function normalizeTitleKey( title ) {
        if ( !title ) {
            return '';
        }
        var t = decodeURIComponent( String( title ) );
        t = t.replace( /_/g, ' ' );
        t = t.trim();
        return t.toLowerCase();
    }

    // 1) Collect all titles (audio + artwork + cover) to query
    var titleSet = Object.create( null );
    tracks.forEach( function ( t ) {
        if ( t.fileTitle ) {
            titleSet[ t.fileTitle ] = true;
        }
        if ( t.artworkTitle ) {
            titleSet[ t.artworkTitle ] = true;
        }
    } );
    if ( coverTitle ) {
        titleSet[ coverTitle ] = true;
    }

    var titles = Object.keys( titleSet );
    console.log( '[TTA] fetchFileUrls - titles to query:', titles );

    if ( !titles.length ) {
        return $.Deferred().resolve( { coverUrl: null } ).promise();
    }

    // 2) Query the API for imageinfo
    return api.get( {
        action: 'query',
        titles: titles.join( '|' ),
        prop: 'imageinfo',
        iiprop: 'url',
        format: 'json'
    } ).then( function ( data ) {
        var urlByKey = Object.create( null );
        var coverUrl = null;

        if ( data.query && data.query.pages ) {
            Object.keys( data.query.pages ).forEach( function ( id ) {
                var page = data.query.pages[ id ];
                if ( page.imageinfo && page.imageinfo.length ) {
                    var url = page.imageinfo[ 0 ].url;
                    var key = normalizeTitleKey( page.title );
                    urlByKey[ key ] = url;
                }
            } );
        }

        // 3) Attach URLs to tracks using normalized keys
        tracks.forEach( function ( t ) {
            if ( t.fileTitle ) {
                var kFile = normalizeTitleKey( t.fileTitle );
                if ( urlByKey[ kFile ] ) {
                    t.url = urlByKey[ kFile ];
                }
            }
            if ( t.artworkTitle ) {
                var kArt = normalizeTitleKey( t.artworkTitle );
                if ( urlByKey[ kArt ] ) {
                    t.artworkUrl = urlByKey[ kArt ];
                }
            }

            console.log(
                '[TTA] URLS FOR TRACK:',
                t.fileTitle,
                '| artworkTitle=',
                t.artworkTitle,
                '| url=',
                t.url,
                '| artworkUrl=',
                t.artworkUrl
            );
        } );

        if ( coverTitle ) {
            var kCover = normalizeTitleKey( coverTitle );
            if ( urlByKey[ kCover ] ) {
                coverUrl = urlByKey[ kCover ];
            }
        }

        console.log( '[TTA] coverUrl:', coverUrl );
        return { coverUrl: coverUrl };
    } );
}

	/**
	 * Builds the interactive playlist UI for a `.tta-playlist` container.
	 *
	 * Renders:
	 *  - header with cover, title and "N tracks"
	 *  - top controls (prev / play/pause / next / shuffle)
	 *  - ordered tracklist with handle, number, optional thumbnail and labels
	 *  - "Now playing" bar + HTML5 <audio> element
	 *
	 * @param {jQuery} $container Playlist container (original `.tta-playlist` DIV).
	 * @param {Array<Object>} tracks Track objects (with url/artworkUrl already resolved).
	 * @param {string|null} coverUrl URL of the playlist cover image (if any).
	 */
	function buildPlayerUI( $container, tracks, coverUrl ) {
		// Discard tracks with no audio URL
		tracks = tracks.filter( function ( t ) {
			return !!t.url;
		} );
		if ( !tracks.length ) {
			return;
		}

		var current = 0;
		var isPlaying = false;
		var isShuffle = false;

		var $wrapper = $( '<div>' ).addClass( 'tta-playlist-wrapper' );

		// ---- HEADER ----------------------------------------------------------------
		var $headerRow = $( '<div>' ).addClass( 'tta-playlist-header-row' );
		var $cover = $( '<div>' ).addClass( 'tta-playlist-cover' );

		if ( coverUrl ) {
			$cover.append(
				$( '<img>' )
					.addClass( 'tta-playlist-cover-img' )
					.attr( 'src', coverUrl )
			);
		}

		var $meta = $( '<div>' ).addClass( 'tta-playlist-meta' );
		var $title = $( '<div>' )
			.addClass( 'tta-playlist-title' )
			.text( $container.data( 'title' ) || 'Playlist' );
		var $subtitle = $( '<div>' )
			.addClass( 'tta-playlist-subtitle' )
			.text( tracks.length + ( tracks.length === 1 ? ' track' : ' tracks' ) );

		var $controlsTop = $( '<div>' ).addClass( 'tta-playlist-controls-top' );
		var $btnPrev = $( '<button>' )
			.addClass( 'tta-playlist-btn tta-playlist-prev' )
			.attr( 'type', 'button' )
			.text( '◀' );
		var $btnPlayPause = $( '<button>' )
			.addClass( 'tta-playlist-btn tta-playlist-playpause' )
			.attr( 'type', 'button' )
			.text( '▶' );
		var $btnNext = $( '<button>' )
			.addClass( 'tta-playlist-btn tta-playlist-next' )
			.attr( 'type', 'button' )
			.text( '▶' );
		var $btnShuffle = $( '<button>' )
			.addClass( 'tta-playlist-btn tta-playlist-shuffle' )
			.attr( 'type', 'button' )
			.attr( 'title', 'Shuffle on/off' )
			.text( '🔀' );

		$controlsTop.append( $btnPrev, $btnPlayPause, $btnNext, $btnShuffle );
		$meta.append( $title, $subtitle, $controlsTop );
		$headerRow.append( $cover, $meta );
		$wrapper.append( $headerRow );

		// ---- TRACKLIST ------------------------------------------------------------
		var $trackList = $( '<ol>' ).addClass( 'tta-playlist-tracklist' );

		tracks.forEach( function ( t, idx ) {
			var $row = $( '<li>' )
				.addClass( 'tta-playlist-track' )
				.attr( 'draggable', 'true' )
				.attr( 'data-filetitle', t.fileTitle );

			// Left drag handle
			var $handle = $( '<span>' )
				.addClass( 'tta-track-handle' )
				.attr( 'title', 'Drag to reorder' )
				.text( '⋮⋮' );

			// Track number
			var $num = $( '<span>' )
				.addClass( 'tta-track-num' )
				.text( idx + 1 );

			// Optional per-track thumbnail
			var $thumb = null;
			if ( t.artworkUrl ) {
				$thumb = $( '<span>' )
					.addClass( 'tta-track-thumb' )
					.append(
						$( '<img>' )
							.addClass( 'tta-track-thumb-img' )
							.attr( 'src', t.artworkUrl )
					);
			}

			// Title + extra
			var $text = $( '<div>' ).addClass( 'tta-track-text' );
			$text.append(
				$( '<div>' )
					.addClass( 'tta-track-title' )
					.text( t.title || t.pretty )
			);
			if ( t.extra ) {
				$text.append(
					$( '<div>' )
						.addClass( 'tta-track-extra' )
						.text( t.extra )
				);
			}

			// Restore intended order: handle → number → (optional) thumb → text
			$row.append( $handle, $num );
			if ( $thumb ) {
				$row.append( $thumb );
			}
			$row.append( $text );

			t.$row = $row;

			// Click to play this track (ignoring clicks on the handle)
			$row.on( 'click', function ( e ) {
				if ( $( e.target ).closest( '.tta-track-handle' ).length ) {
					return;
				}
				var idxNow = tracks.indexOf( t );
				if ( idxNow !== -1 ) {
					loadTrack( idxNow, true );
				}
			} );

			$trackList.append( $row );
		} );

		$wrapper.append( $trackList );

		// ---- NOW PLAYING SECTION --------------------------------------------------
		var $nowPlaying = $( '<div>' ).addClass( 'tta-playlist-nowplaying' );
		var $currentTitle = $( '<div>' ).addClass( 'tta-nowplaying-title' );
		var $audio = $( '<audio>' )
			.addClass( 'tta-playlist-audio' )
			.attr( { controls: 'controls', preload: 'none' } );

		$nowPlaying.append( $currentTitle, $audio );
		$wrapper.append( $nowPlaying );

		// Replace original container content with the UI
		$container.empty().append( $wrapper );

		// ---- INTERNAL PLAYER HELPERS ---------------------------------------------

		/**
		 * Visually highlight the current track row.
		 */
		function updateHighlight() {
			tracks.forEach( function ( t ) {
				t.$row.removeClass( 'is-current' );
			} );
			if ( tracks[ current ] ) {
				tracks[ current ].$row.addClass( 'is-current' );
			}
		}

		/**
		 * Sync the play/pause button text with the actual playback state.
		 */
		function updatePlayButton() {
			$btnPlayPause.text( isPlaying ? '⏸' : '▶' );
		}

		/**
		 * Choose a different, random index for shuffle mode.
		 *
		 * @return {number} New track index (different from current).
		 */
		function randomNextIndex() {
			if ( tracks.length <= 1 ) {
				return current;
			}
			var idx;
			do {
				idx = Math.floor( Math.random() * tracks.length );
			} while ( idx === current );
			return idx;
		}

		/**
		 * Load the track at the given index, optionally starting playback.
		 *
		 * @param {number} index Track index to load.
		 * @param {boolean} autoplay Whether to start playback immediately.
		 */
		function loadTrack( index, autoplay ) {
			if ( index < 0 || index >= tracks.length ) {
				return;
			}

			current = index;
			var t = tracks[ index ];

			$audio.attr( 'src', t.url );

			var np = t.title || t.pretty;
			if ( t.extra ) {
				np += ' – ' + t.extra;
			}
			$currentTitle.text( ( index + 1 ) + '. ' + np );

			updateHighlight();

			if ( autoplay ) {
				$audio[ 0 ].currentTime = 0;
				$audio[ 0 ].play();
				isPlaying = true;
				updatePlayButton();
			} else {
				isPlaying = false;
				updatePlayButton();
			}
		}

		// ---- BUTTON BINDINGS -----------------------------------------------------

		$btnPrev.on( 'click', function () {
			loadTrack(
				isShuffle ?
					randomNextIndex() :
					( current - 1 + tracks.length ) % tracks.length,
				true
			);
		} );

		$btnNext.on( 'click', function () {
			loadTrack(
				isShuffle ?
					randomNextIndex() :
					( current + 1 ) % tracks.length,
				true
			);
		} );

		$btnShuffle.on( 'click', function () {
			isShuffle = !isShuffle;
			$btnShuffle.toggleClass( 'is-active', isShuffle );
		} );

		$btnPlayPause.on( 'click', function () {
			if ( !$audio.attr( 'src' ) ) {
				return loadTrack( current, true );
			}
			if ( $audio[ 0 ].paused ) {
				$audio[ 0 ].play();
				isPlaying = true;
			} else {
				$audio[ 0 ].pause();
				isPlaying = false;
			}
			updatePlayButton();
		} );

		// Keep button state in sync with <audio> events
		$audio.on( 'play', function () {
			isPlaying = true;
			updatePlayButton();
		} );
		$audio.on( 'pause', function () {
			isPlaying = false;
			updatePlayButton();
		} );
		$audio.on( 'ended', function () {
			loadTrack(
				isShuffle ?
					randomNextIndex() :
					( current + 1 ) % tracks.length,
				true
			);
		} );

		// Enable drag & drop reordering (client-side only)
		enableDragAndDrop( $trackList, tracks, updateHighlight );

		// Start with the first track loaded but not playing
		loadTrack( 0, false );
	}

	/**
	 * Enable drag & drop reordering of playlist tracks inside the given list.
	 *
	 * NOTE: This only updates the order in memory and in the DOM; the actual
	 * persistence of the new order in wikitext is handled by the Manager gadget.
	 *
	 * @param {jQuery} $trackList The <ol> or <ul> containing `.tta-playlist-track` items.
	 * @param {Array<Object>} tracks Array of track objects to be re-ordered in place.
	 * @param {Function} onReorder Callback invoked after a successful reorder.
	 */
	function enableDragAndDrop( $trackList, tracks, onReorder ) {
		var dragIndex = null;

		$trackList.on( 'dragstart', '.tta-playlist-track', function ( e ) {
			var $row = $( this );
			dragIndex = $row.index();
			$row.addClass( 'is-dragging' );

			if ( e.originalEvent && e.originalEvent.dataTransfer ) {
				e.originalEvent.dataTransfer.effectAllowed = 'move';
				e.originalEvent.dataTransfer.setData( 'text/plain', '' );
			}
		} );

		$trackList.on( 'dragover', '.tta-playlist-track', function ( e ) {
			e.preventDefault();
			var $target = $( this );
			var $dragging = $trackList.find( '.tta-playlist-track.is-dragging' );
			if (
				!$dragging.length ||
				$dragging[ 0 ] === $target[ 0 ]
			) {
				return;
			}

			var targetIndex = $target.index();
			if ( targetIndex > dragIndex ) {
				$target.after( $dragging );
			} else {
				$target.before( $dragging );
			}
		} );

		// Prevent default drop behavior (we handle the reorder manually)
		$trackList.on( 'drop', '.tta-playlist-track', function ( e ) {
			e.preventDefault();
		} );

		$trackList.on( 'dragend', '.tta-playlist-track', function () {
			var $rows = $trackList.children( '.tta-playlist-track' );
			var newTracks = [];

			// Rebuild the track array following the new DOM order
			$rows.each( function ( idx ) {
				var $row = $( this );
				var fileTitle = $row.attr( 'data-filetitle' );

				var t = null;
				for ( var i = 0; i < tracks.length; i++ ) {
					if ( !tracks[ i ]._used && tracks[ i ].fileTitle === fileTitle ) {
						t = tracks[ i ];
						tracks[ i ]._used = true;
						break;
					}
				}
				if ( !t ) {
					// Fallback: if no match was found, keep original ordering guess
					t = tracks[ idx ];
					tracks[ idx ]._used = true;
				}

				t.$row = $row;
				newTracks.push( t );
				$row.find( '.tta-track-num' ).text( idx + 1 );
				$row.removeClass( 'is-dragging' );
			} );

			// Clear temporary markers
			newTracks.forEach( function ( t ) {
				delete t._used;
			} );

			// Replace original array contents with the newly ordered list
			tracks.length = 0;
			Array.prototype.push.apply( tracks, newTracks );

			if ( typeof onReorder === 'function' ) {
				onReorder();
			}
		} );
	}

	/**
	 * Initialize all `.tta-playlist` containers within a given root.
	 *
	 * This:
	 *  - avoids double initialization via a data flag
	 *  - collects tracks
	 *  - resolves URLs via fetchFileUrls
	 *  - builds the UI via buildPlayerUI
	 *
	 * @param {jQuery} [$root] Optional root context (defaults to $(document)).
	 */
	function initAll( $root ) {
		( $root || $( document ) )
			.find( '.tta-playlist' )
			.each( function () {
				var $container = $( this );

				if ( $container.data( 'ttaPlaylistInit' ) ) {
					return;
				}
				$container.data( 'ttaPlaylistInit', true );

				var tracks = collectTracks( $container );
				if ( !tracks.length ) {
					return;
				}

				var coverTitle = $container.data( 'cover' );
				if ( coverTitle && coverTitle.indexOf( 'File:' ) !== 0 ) {
					coverTitle = 'File:' + coverTitle;
				}

				fetchFileUrls( tracks, coverTitle )
					.then( function ( info ) {
						buildPlayerUI( $container, tracks, info.coverUrl );
					} );
			} );
	}

	// Initial run on page load
	$( function () {
		initAll( $( document ) );
	} );

	// Re-run when page content is re-rendered (e.g. via AJAX)
	mw.hook( 'wikipage.content' ).add( initAll );

}( mediaWiki, jQuery ) );