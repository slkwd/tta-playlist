/* global mediaWiki, jQuery */
( function ( mw, $ ) {
	'use strict';

	console.log( 'ttaPlaylist gadget v2.19 restored (handle-left, no-trash) + console.logs' );

	/**
	 * Estrae le tracce da un contenitore .tta-playlist
	 * Legge anche l'eventuale commento <!--ART:File:XXX.jpg--> per ciascun <li>
	 */
	function collectTracks( $container ) {
	    var tracks = [];

	    console.group( '[TTA] collectTracks' );

	    // 1) Tracce dalle <li>
	    $container.find( 'li' ).each( function () {
	        var $li = $( this );
	        var $link = $li.find( 'a' ).first();
	        if ( !$link.length ) {
	            return;
	        }

	        var fileTitle = $link.attr( 'title' );
	        if ( !fileTitle ) {
	            var href = $link.attr( 'href' ) || '';
	            var parts = href.split( '/' );
	            fileTitle = decodeURIComponent( parts.pop() || '' );
	        }

	        // Normalizzazione fileTitle: prefisso File:, underscore -> spazio
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

	    // 2) Mappa artwork dalla <div class="tta-playlist-artworks">
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

	        // Normalizza file come facciamo per fileTitle
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

	    // 3) Applica la mappa alle tracce
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
	 * Recupera URL dei file audio + artwork
	 */
	function fetchFileUrls( tracks, coverTitle ) {
		var api = new mw.Api();
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

		return api.get( {
			action: 'query',
			titles: titles.join( '|' ),
			prop: 'imageinfo',
			iiprop: 'url',
			format: 'json'
		} ).then( function ( data ) {
			var urlByTitle = Object.create( null );
			var coverUrl = null;

			if ( data.query && data.query.pages ) {
				Object.keys( data.query.pages ).forEach( function ( id ) {
					var page = data.query.pages[ id ];
					if ( page.imageinfo && page.imageinfo.length ) {
						urlByTitle[ page.title ] = page.imageinfo[ 0 ].url;
					}
				} );
			}

			tracks.forEach( function ( t ) {
				if ( t.fileTitle && urlByTitle[ t.fileTitle ] ) {
					t.url = urlByTitle[ t.fileTitle ];
				}
				if ( t.artworkTitle && urlByTitle[ t.artworkTitle ] ) {
					t.artworkUrl = urlByTitle[ t.artworkTitle ];
				}
				console.log( '[TTA] URLS FOR TRACK:',
					t.fileTitle,
					'| artworkTitle=', t.artworkTitle,
					'| url=', t.url,
					'| artworkUrl=', t.artworkUrl
				);
			} );

			if ( coverTitle && urlByTitle[ coverTitle ] ) {
				coverUrl = urlByTitle[ coverTitle ];
			}

			console.log( '[TTA] coverUrl:', coverUrl );
			return { coverUrl: coverUrl };
		} );
	}

	/**
	 * Costruisce la UI del player
	 */
	function buildPlayerUI( $container, tracks, coverUrl ) {
		tracks = tracks.filter( function ( t ) { return !!t.url; } );
		if ( !tracks.length ) return;

		var current = 0;
		var isPlaying = false;
		var isShuffle = false;

		var $wrapper = $( '<div>' ).addClass( 'tta-playlist-wrapper' );

		// ---- HEADER ----
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
		var $title = $( '<div>' ).addClass( 'tta-playlist-title' )
			.text( $container.data( 'title' ) || 'Playlist' );
		var $subtitle = $( '<div>' ).addClass( 'tta-playlist-subtitle' )
			.text( tracks.length + ( tracks.length === 1 ? ' track' : ' tracks' ) );

		var $controlsTop = $( '<div>' ).addClass( 'tta-playlist-controls-top' );
		var $btnPrev = $( '<button>' ).addClass( 'tta-playlist-btn tta-playlist-prev' )
			.attr( 'type', 'button' ).text( '◀' );
		var $btnPlayPause = $( '<button>' ).addClass( 'tta-playlist-btn tta-playlist-playpause' )
			.attr( 'type', 'button' ).text( '▶' );
		var $btnNext = $( '<button>' ).addClass( 'tta-playlist-btn tta-playlist-next' )
			.attr( 'type', 'button' ).text( '▶' );
		var $btnShuffle = $( '<button>' ).addClass( 'tta-playlist-btn tta-playlist-shuffle' )
			.attr( 'type', 'button' ).attr( 'title', 'Shuffle on/off' ).text( '🔀' );

		$controlsTop.append( $btnPrev, $btnPlayPause, $btnNext, $btnShuffle );
		$meta.append( $title, $subtitle, $controlsTop );
		$headerRow.append( $cover, $meta );
		$wrapper.append( $headerRow );

		// ---- TRACKLIST ----
		var $trackList = $( '<ol>' ).addClass( 'tta-playlist-tracklist' );

		tracks.forEach( function ( t, idx ) {
			var $row = $( '<li>' )
				.addClass( 'tta-playlist-track' )
				.attr( 'draggable', 'true' )
				.attr( 'data-filetitle', t.fileTitle );

			var $handle = $( '<span>' )
				.addClass( 'tta-track-handle' )
				.attr( 'title', 'Drag to reorder' )
				.text( '⋮⋮' );

			var $num = $( '<span>' )
				.addClass( 'tta-track-num' )
				.text( idx + 1 );

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

			var $text = $( '<div>' ).addClass( 'tta-track-text' );
			$text.append(
				$( '<div>' ).addClass( 'tta-track-title' ).text( t.title || t.pretty )
			);
			if ( t.extra ) {
				$text.append(
					$( '<div>' ).addClass( 'tta-track-extra' ).text( t.extra )
				);
			}

			// ✨ ORDINAMENTO RIPRISTINATO: handle → num → thumb → text
			$row.append( $handle, $num );
			if ( $thumb ) $row.append( $thumb );
			$row.append( $text );

			t.$row = $row;

			$row.on( 'click', function ( e ) {
				if ( $( e.target ).closest( '.tta-track-handle' ).length ) return;
				var idxNow = tracks.indexOf( t );
				if ( idxNow !== -1 ) loadTrack( idxNow, true );
			} );

			$trackList.append( $row );
		} );

		$wrapper.append( $trackList );

		// ---- NOW PLAYING ----
		var $nowPlaying = $( '<div>' ).addClass( 'tta-playlist-nowplaying' );
		var $currentTitle = $( '<div>' ).addClass( 'tta-nowplaying-title' );
		var $audio = $( '<audio>' )
			.addClass( 'tta-playlist-audio' )
			.attr( { controls: 'controls', preload: 'none' } );

		$nowPlaying.append( $currentTitle, $audio );
		$wrapper.append( $nowPlaying );

		$container.empty().append( $wrapper );

		// ---- FUNZIONI PLAYER ----
		function updateHighlight() {
			tracks.forEach( t => t.$row.removeClass( 'is-current' ) );
			if ( tracks[ current ] ) tracks[ current ].$row.addClass( 'is-current' );
		}

		function updatePlayButton() {
			$btnPlayPause.text( isPlaying ? '⏸' : '▶' );
		}

		function randomNextIndex() {
			if ( tracks.length <= 1 ) return current;
			var idx;
			do {
				idx = Math.floor( Math.random() * tracks.length );
			} while ( idx === current );
			return idx;
		}

		function loadTrack( index, autoplay ) {
			if ( index < 0 || index >= tracks.length ) return;

			current = index;
			var t = tracks[ index ];

			$audio.attr( 'src', t.url );

			var np = t.title || t.pretty;
			if ( t.extra ) np += ' – ' + t.extra;
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

		$btnPrev.on( 'click', function () {
			loadTrack( isShuffle ? randomNextIndex() : ( current - 1 + tracks.length ) % tracks.length, true );
		} );

		$btnNext.on( 'click', function () {
			loadTrack( isShuffle ? randomNextIndex() : ( current + 1 ) % tracks.length, true );
		} );

		$btnShuffle.on( 'click', function () {
			isShuffle = !isShuffle;
			$btnShuffle.toggleClass( 'is-active', isShuffle );
		} );

		$btnPlayPause.on( 'click', function () {
			if ( !$audio.attr( 'src' ) ) return loadTrack( current, true );
			if ( $audio[ 0 ].paused ) {
				$audio[ 0 ].play(); isPlaying = true;
			} else {
				$audio[ 0 ].pause(); isPlaying = false;
			}
			updatePlayButton();
		} );

		$audio.on( 'play', function () { isPlaying = true; updatePlayButton(); } );
		$audio.on( 'pause', function () { isPlaying = false; updatePlayButton(); } );
		$audio.on( 'ended', function () {
			loadTrack( isShuffle ? randomNextIndex() : ( current + 1 ) % tracks.length, true );
		} );

		enableDragAndDrop( $trackList, tracks, updateHighlight );

		loadTrack( 0, false );
	}

	/**
	 * Drag & drop
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
			if ( !$dragging.length || $dragging[ 0 ] === $target[ 0 ] ) return;

			var targetIndex = $target.index();
			if ( targetIndex > dragIndex ) {
				$target.after( $dragging );
			} else {
				$target.before( $dragging );
			}
		} );

		$trackList.on( 'drop', '.tta-playlist-track', function ( e ) { e.preventDefault(); } );

		$trackList.on( 'dragend', '.tta-playlist-track', function () {
			var $rows = $trackList.children( '.tta-playlist-track' );
			var newTracks = [];

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
					t = tracks[ idx ];
					tracks[ idx ]._used = true;
				}

				t.$row = $row;
				newTracks.push( t );
				$row.find( '.tta-track-num' ).text( idx + 1 );
				$row.removeClass( 'is-dragging' );
			} );

			newTracks.forEach( function ( t ) { delete t._used; } );

			tracks.length = 0;
			Array.prototype.push.apply( tracks, newTracks );

			if ( typeof onReorder === 'function' ) onReorder();
		} );
	}

	/**
	 * Inizializza
	 */
	function initAll( $root ) {
		( $root || $( document ) ).find( '.tta-playlist' ).each( function () {
			var $container = $( this );

			if ( $container.data( 'ttaPlaylistInit' ) ) return;
			$container.data( 'ttaPlaylistInit', true );

			var tracks = collectTracks( $container );
			if ( !tracks.length ) return;

			var coverTitle = $container.data( 'cover' );
			if ( coverTitle && coverTitle.indexOf( 'File:' ) !== 0 ) {
				coverTitle = 'File:' + coverTitle;
			}

			fetchFileUrls( tracks, coverTitle ).then( function ( info ) {
				buildPlayerUI( $container, tracks, info.coverUrl );
			} );
		} );
	}

	$( function () { initAll( $( document ) ); } );
	mw.hook( 'wikipage.content' ).add( initAll );

}( mediaWiki, jQuery ) );
