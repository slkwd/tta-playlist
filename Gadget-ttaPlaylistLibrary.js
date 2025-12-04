/* global mediaWiki, jQuery */
/**
 * TTA Playlist Library gadget
 *
 * Renders a visual gallery of a user's playlists on:
 *   User:<name>/Playlists
 *
 * The gadget:
 * - Detects the "My playlists" section in the user library page
 * - Reads the plain wikitext list of playlist links between library markers
 * - Fetches each playlist page content and extracts:
 *   - data-title (display name)
 *   - data-cover (cover file)
 *   - number of tracks
 * - Builds a responsive card gallery with cover images or placeholders
 * - Hides the original textual list (via CSS class on the content root)
 *
 * This gadget is read-only: it does not modify any page content, only enhances
 * the client-side presentation of the playlist library.
 */
( function ( mw, $ ) {
    'use strict';

    console.log( 'ttaPlaylist Library gadget v1.0.0 loaded' );

    // Run only on user pages in the "Playlists" subpage, e.g. "User:Foo/Playlists"
    var title = mw.config.get( 'wgPageName' ) || '';
    if ( mw.config.get( 'wgNamespaceNumber' ) !== 2 ) {
        // Not a User: page
        return;
    }
    if ( !/\/Playlists$/.test( title ) ) {
        // Not the "…/Playlists" root library page
        return;
    }

    // Wait for page content to be ready
    $( function () {
        var $content = $( '.mw-parser-output' );
        if ( !$content.length ) {
            return;
        }

        // Find the "My playlists" section heading
        var $heading = $content.find( 'h2' ).filter( function () {
            return $.trim( $( this ).text() ) === 'My playlists';
        } ).first();

        if ( !$heading.length ) {
            return;
        }

        // Locate the <ul> that immediately follows the heading (the plain list of playlists)
        var $ul = $heading.nextAll( 'ul' ).first();
        if ( !$ul.length ) {
            return;
        }

        var playlists = [];
        var seen = Object.create( null );

        // Extract unique playlist links from the list
        $ul.find( 'a[href*="/Playlists/"]' ).each( function () {
            var $a = $( this );
            var pageTitle = $a.attr( 'title' ) || $a.text();
            if ( !pageTitle ) {
                return;
            }
            if ( seen[ pageTitle ] ) {
                return;
            }
            seen[ pageTitle ] = true;

            playlists.push( {
                // Example: "User:Foo/Playlists/Northumberland_20251201093811"
                pageTitle: pageTitle,
                displayTitle: $a.text().trim() || pageTitle
            } );
        } );

        if ( !playlists.length ) {
            return;
        }

        var api = new mw.Api();

        /**
         * Fetches the raw wikitext for the given playlist pages and enriches
         * each item with:
         * - rawContent: the page wikitext
         * - coverFile: the value of data-cover="File:..." inside <div class="tta-playlist">
         * - displayTitle: optionally updated from data-title="..."
         * - trackCount: number of tracks (* [[File:...]]) in the playlist
         *
         * @param {Object[]} items Array of playlist metadata objects.
         * @param {string} items[].pageTitle Full page title of the playlist.
         * @param {string} items[].displayTitle Display title extracted from the link or fallback.
         * @return {jQuery.Promise<Object[]>} Promise resolving to the same array, enriched.
         */
        function fetchPlaylistsContent( items ) {
            var titles = items.map( function ( p ) { return p.pageTitle; } );

            return api.get( {
                action: 'query',
                prop: 'revisions',
                rvprop: 'content',
                titles: titles.join( '|' ),
                formatversion: 2,
                format: 'json'
            } ).then( function ( data ) {
                var pages = ( data.query && data.query.pages ) || [];
                var byTitle = Object.create( null );

                // Index pages by title for quick lookup
                pages.forEach( function ( page ) {
                    if ( !page.title ) {
                        return;
                    }
                    byTitle[ page.title ] = page;
                } );

                items.forEach( function ( pl ) {
                    var page = byTitle[ pl.pageTitle ];
                    var content = page && page.revisions && page.revisions[ 0 ] &&
                        page.revisions[ 0 ].content || '';

                    pl.rawContent = content;

                    // Locate the <div class="tta-playlist" ...> wrapper in the playlist page
                    var divMatch = content.match(
                        /<div[^>]*class="tta-playlist"[^>]*>/i
                    );
                    if ( divMatch ) {
                        var divTag = divMatch[ 0 ];

                        // Optional override of display title from data-title
                        var titleMatch = divTag.match( /data-title="([^"]*)"/i );
                        var coverMatch = divTag.match( /data-cover="([^"]*)"/i );

                        if ( titleMatch && !pl.displayTitle ) {
                            pl.displayTitle = titleMatch[ 1 ];
                        }

                        // Cover file is stored as data-cover="File:Cover.jpg"
                        pl.coverFile = coverMatch ? coverMatch[ 1 ] : null;
                    } else {
                        pl.coverFile = null;
                    }

                    // Count tracks by matching lines starting with "* [[File:...]]"
                    var trackMatches = content.match(
                        /^\s*\*\s*\[\[\s*File:[^\]]+\]\]/gmi
                    );
                    pl.trackCount = trackMatches ? trackMatches.length : 0;
                } );

                return items;
            } );
        }

        /**
         * Given a list of playlist items that reference cover files, fetches
         * their thumbnail (or original) URLs via the MediaWiki imageinfo API.
         *
         * @param {Object[]} items Playlist items enriched by fetchPlaylistsContent.
         * @param {string} [items[].coverFile] Optional File: title for the cover.
         * @return {jQuery.Promise<Object<string,string>>}
         *   A promise resolving to a map: { "File:Cover.jpg": "https://…/thumb.jpg", ... }.
         */
        function fetchCoverUrls( items ) {
            var files = [];
            var seenFiles = Object.create( null );

            // Collect distinct File: titles used as covers
            items.forEach( function ( pl ) {
                if ( pl.coverFile && !seenFiles[ pl.coverFile ] ) {
                    seenFiles[ pl.coverFile ] = true;
                    files.push( pl.coverFile );
                }
            } );

            if ( !files.length ) {
                // No covers to resolve → return an empty map
                return $.Deferred().resolve( {} ).promise();
            }

            return api.get( {
                action: 'query',
                prop: 'imageinfo',
                iiprop: 'url',
                iiurlwidth: 260,
                titles: files.join( '|' ),
                formatversion: 2,
                format: 'json'
            } ).then( function ( data ) {
                var pages = ( data.query && data.query.pages ) || [];
                var map = Object.create( null );

                pages.forEach( function ( page ) {
                    if ( !page.title ) {
                        return;
                    }
                    var info = page.imageinfo && page.imageinfo[ 0 ];
                    if ( info ) {
                        // Prefer thumburl when available, fallback to full URL
                        map[ page.title ] = info.thumburl || info.url;
                    }
                } );

                return map;
            } );
        }

        /**
         * Builds and injects the visual gallery for the playlist library.
         *
         * It:
         * - Creates a responsive grid of cards (cover + title + track count)
         * - Inserts the gallery right after the "My playlists" heading
         * - Adds a CSS class to the content root so that the raw textual list
         *   can be hidden via stylesheet rules.
         *
         * @param {Object[]} items Enriched playlist items.
         * @param {string} items[].pageTitle Full page title of the playlist.
         * @param {string} items[].displayTitle Human-readable playlist name.
         * @param {string|null} items[].coverFile File: title of the cover (if any).
         * @param {number} items[].trackCount Number of tracks in the playlist.
         * @param {Object<string,string>} coverMap Map of File: title → cover URL.
         */
        function buildGallery( items, coverMap ) {
            var $gallery = $( '<div>' )
                .addClass( 'tta-playlist-library-gallery' );

            items.forEach( function ( pl ) {
                var href = mw.util.getUrl( pl.pageTitle );

                // Card wrapper
                var $card = $( '<a>' )
                    .addClass( 'tta-playlist-card' )
                    .attr( 'href', href );

                // Cover area
                var $cover = $( '<div>' )
                    .addClass( 'tta-playlist-card-cover' );

                var coverUrl = pl.coverFile && coverMap[ pl.coverFile ];
                if ( coverUrl ) {
                    // Real cover image
                    $( '<img>' )
                        .attr( {
                            src: coverUrl,
                            alt: pl.displayTitle + ' cover'
                        } )
                        .appendTo( $cover );
                } else {
                    // Simple placeholder: first letter of the display title (or ?)
                    var initial = ( pl.displayTitle || '?' ).charAt( 0 );
                    $( '<div>' )
                        .addClass( 'tta-playlist-card-cover-placeholder' )
                        .text( initial )
                        .appendTo( $cover );
                }

                // Card body: title + meta info
                var $body = $( '<div>' )
                    .addClass( 'tta-playlist-card-body' );

                $( '<div>' )
                    .addClass( 'tta-playlist-card-title' )
                    .text( pl.displayTitle )
                    .appendTo( $body );

                var metaText;
                if ( pl.trackCount === 1 ) {
                    metaText = '1 track';
                } else {
                    metaText = pl.trackCount + ' tracks';
                }

                $( '<div>' )
                    .addClass( 'tta-playlist-card-meta' )
                    .text( metaText )
                    .appendTo( $body );

                $card.append( $cover, $body );
                $gallery.append( $card );
            } );

            // Insert the gallery immediately after the "My playlists" heading
            $gallery.insertAfter( $heading );

            // Mark the content as "has gallery" so CSS can hide the old bullet list
            $content.addClass( 'tta-playlist-library-has-gallery' );
        }

        // Pipeline:
        // 1) Fetch playlist page contents (to get data-title, data-cover, track counts)
        // 2) Fetch cover image URLs
        // 3) Render the gallery
        fetchPlaylistsContent( playlists )
            .then( function ( items ) {
                return fetchCoverUrls( items ).then( function ( coverMap ) {
                    buildGallery( items, coverMap );
                } );
            } )
            .fail( function ( e ) {
                console.error( '[TTA] PlaylistLibrary gadget error:', e );
            } );
    } );
}( mediaWiki, jQuery ) );