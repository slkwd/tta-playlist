/**
 * TTA Playlist Manager gadget
 *
 * This MediaWiki gadget provides the management layer for the TTA playlists:
 *  - Creates and maintains per-user playlist library pages: User:<name>/Playlists
 *  - Creates individual playlist pages under User:<name>/Playlists/...
 *  - Appends/removes tracks and keeps artwork mappings in sync
 *  - Handles drag-and-drop reordering and persistence of the new order
 *  - Exposes an OOUI dialog ("Add to playlist") and an owner menu (⋮) on playlist pages
 *
 * The gadget is designed for The Traditional Tune Archive (TTA) and expects:
 *  - Wikitext playlists wrapped in <div class="tta-playlist" ...>
 *  - A hidden <div class="tta-playlist-artworks"> block with <span data-file=... data-artwork=...>
 *  - A user library page to be located at: User:<name>/Playlists
 *
 * Dependencies:
 *  - mediaWiki (mw)
 *  - jQuery ($)
 *  - OOUI (oojs-ui-core, oojs-ui-windows, oojs-ui-widgets)
 */

/* global mediaWiki, jQuery */
( function ( mw, $ ) {
    'use strict';
    console.log( 'ttaPlaylist Manager gadget v2.12.38 loaded' );

    // Run only for authenticated users
    var username = mw.config.get( 'wgUserName' );
    if ( !username ) {
        return;
    }

    // Styles for playlist lists and management buttons
    mw.util.addCSS(
        '.tta-playlist-list { margin-top: 8px; }' +
        '.tta-playlist-item { padding: 4px 10px; cursor: pointer; border-radius: 4px; }' +
        '.tta-playlist-item:hover { background: #f3f4f7; }' +
        '.tta-playlist-item--selected { background: #e2e7f5; font-weight: bold; }' +
        '.tta-remove-track-btn { margin-left: 8px; font-size: 11px; padding: 0 4px; }' +
        '.tta-rename-playlist-btn { margin-bottom: 8px; padding: 4px 8px; font-size: 12px; }' +
        '.tta-playlist-owner-bar { display:flex; justify-content:flex-end; margin-bottom:4px; }' +
        '.tta-playlist-owner-bar .oo-ui-buttonElement { margin-left: 4px; }'
    );

    // Helper for regex
    /**
     * Escape a string so it can be safely embedded inside RegExp patterns.
     * @param {string} s Raw string to escape.
     * @return {string} Escaped string safe for use in regex literals.
     */
    function escapeRegex ( s ) {
        return String( s ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
    }




    // ------------------------------------------------------------
    // 1) FeaturedTunes "+" button
    // ------------------------------------------------------------

    /**
     * Enhance FeaturedTunes embeds by injecting a playlist "+" button and wiring the dialog opener.
     * Safe-guards against duplicate bindings and normalizes extra metadata from the embed dataset.
     * @param {jQuery} $root Optional root to scope the search (defaults to document).
     */
    function enhanceEmbeds ( $root ) {
        if ( !$root || !$root.jquery ) {
            $root = $( document );
        }

        $root.find( '.tta-track-embed' ).each( function () {
            var $embed = $( this );

            if ( $embed.data( 'ttaPlaylistBound' ) ) {
                return;
            }
            $embed.data( 'ttaPlaylistBound', true );

            var fileTitle = $embed.data( 'filetitle' ); // "File:Something.mp3"
            if ( !fileTitle ) {
                return;
            }

            // Extract extra text: "[https://... The City Waites]" -> "The City Waites"
            var extraRaw = $embed.data( 'extra' ) || '';
            var extra = extraRaw;
            if ( extraRaw ) {
                var m = String( extraRaw ).match( /\[(?:[^\s]+)\s+([^\]]+)\]/ );
                if ( m ) {
                    extra = m[ 1 ];
                }
            }

            // Artwork file title (e.g., "File:Wit_and_Mirth.png")
            var artworkTitle = $embed.data( 'artwork' ) || null;

            var $btnWrapper = $( '<div>' )
                .addClass( 'tta-add-to-playlist-wrapper' );

            var $btn = $( '<button>' )
                .attr( 'type', 'button' )
                .attr( 'title', 'Add this track to a playlist' )
                .addClass( 'tta-add-to-playlist' )
                .text( '+' );

            // Always use dialog mode
            $btn.on( 'click', function () {
                openAddToPlaylistDialog( fileTitle, extra, artworkTitle );
            } );

            $btnWrapper.append( $btn );
            $embed.append( $btnWrapper );
        } );
    }

    // ------------------------------------------------------------
    // 2) Playlist write helpers (wiki-side)
    // ------------------------------------------------------------

    /**
     * Append a track to a playlist page, rebuilding the playlist div and hidden artwork block.
     * Initializes an empty playlist page if needed and normalizes File: prefixes for track/artwork.
     * @param {mw.Api} api MediaWiki API instance.
     * @param {string} playlistTitle Target playlist page.
     * @param {string} fileTitle Track title (with or without File: prefix).
     * @param {string|null} extra Optional extra info shown after the track.
     * @param {string|null} artworkTitle Optional artwork to map to the track.
     * @return {jQuery.Promise} Resolves after saving the page.
     */
    function appendTrackToPlaylist ( api, playlistTitle, fileTitle, extra, artworkTitle ) {
        return api.get( {
            action: 'query',
            prop: 'revisions',
            rvprop: 'content',
            titles: playlistTitle,
            formatversion: 2,
            format: 'json'
        } ).then( function ( data ) {
            var page = data.query && data.query.pages && data.query.pages[ 0 ];
            var content = ( page && page.revisions && page.revisions[ 0 ] && page.revisions[ 0 ].content ) || '';

            // Bootstrap an empty playlist page with a minimal skeleton
            if ( !/\S/.test( content ) ) {
                var parts = playlistTitle.split( '/' );
                var niceName = parts[ parts.length - 1 ].replace( /_/g, ' ' );
                content =
                    '__NOTITLE__\n\n' +
                    '== ' + niceName + ' ==\n\n' +
                    '<div class="tta-playlist" data-title="' + niceName + '">\n' +
                    '</div>\n';
            }

            // Normalize file/artwork prefixes
            if ( fileTitle.indexOf( 'File:' ) !== 0 ) {
                fileTitle = 'File:' + fileTitle;
            }
            if ( artworkTitle && artworkTitle.indexOf( 'File:' ) !== 0 ) {
                artworkTitle = 'File:' + artworkTitle;
            }

            // Locate the playlist div content and rebuild it with a greedy match to capture all blocks
            var divRe = /(<div[^>]*class="tta-playlist"[^>]*>)([\s\S]*)(<\/div>)/;
            content = content.replace( divRe, function ( _all, open, inner, close ) {

                // Collect all existing artwork spans across any blocks
                var artworkRe = /<div\s+class="tta-playlist-artworks"[^>]*>([\s\S]*?)<\/div>/g;
                var spanRe = /<span[^>]*data-file="([^"]+)"[^>]*data-artwork="([^"]+)"[^>]*>\s*<\/span>/g;
                var artworksRaw = '';
                var m, mSpan;

                while ( ( m = artworkRe.exec( inner ) ) ) {
                    artworksRaw += m[ 1 ];
                }

                var artworkMap = Object.create( null );
                while ( ( mSpan = spanRe.exec( artworksRaw ) ) ) {
                    var f = mSpan[ 1 ];
                    var a = mSpan[ 2 ];
                    artworkMap[ f ] = a;
                }

                // Add or update artwork for the current file
                if ( artworkTitle ) {
                    var safeFile = fileTitle.replace( /"/g, '&quot;' );
                    var safeArtwork = artworkTitle.replace( /"/g, '&quot;' );
                    artworkMap[ safeFile ] = safeArtwork;
                }

                // Strip old artwork blocks from inner content
                inner = inner.replace( artworkRe, '' );

                // Append the new playlist line after existing bullets
                var trimmed = inner.replace( /\s+$/, '' ); // trim trailing whitespace
                var line = '* [[' + fileTitle + ']]';
                if ( extra ) {
                    line += ' // ' + extra;
                }

                var bullets = trimmed;
                if ( bullets && !/\n$/.test( bullets ) ) {
                    bullets += '\n';
                }
                bullets += line + '\n';

                // Rebuild a single artwork block if mappings exist
                var artworkBlock = '';
                var keys = Object.keys( artworkMap );
                if ( keys.length ) {
                    artworkBlock = '<div class="tta-playlist-artworks" style="display:none">\n';
                    keys.forEach( function ( f ) {
                        var a = artworkMap[ f ];
                        artworkBlock +=
                            '<span data-file="' + f +
                            '" data-artwork="' + a + '"></span>\n';
                    } );
                    artworkBlock += '</div>\n';
                }

                // Recompose the normalized playlist div
                var newInner = '\n' + bullets + artworkBlock;
                return open + newInner + close;
            } );

            // Save the page
            return api.postWithToken( 'csrf', {
                action: 'edit',
                title: playlistTitle,
                text: content,
                summary: 'Add track to playlist',
                minor: true,
                nocreate: 1,
                format: 'json'
            } );
        } );
    }

    /**
     * Remove a track from a playlist page and update the associated hidden artwork block.
     * Handles both space and underscore variants when matching track lines.
     * @param {mw.Api} api MediaWiki API instance.
     * @param {string} playlistTitle Playlist page title.
     * @param {string} fileTitle Track title to remove.
     * @return {jQuery.Promise} Resolves after saving; errors are notified to the user.
     */
    function removeTrackFromPlaylist ( api, playlistTitle, fileTitle ) {
        return api.get( {
            action: 'query',
            prop: 'revisions',
            rvprop: 'content',
            titles: playlistTitle,
            formatversion: 2,
            format: 'json'
        } ).then( function ( data ) {
            var page = data.query.pages[ 0 ];
            if ( !page.revisions || !page.revisions.length ) {
                throw new Error( 'Playlist page not found' );
            }
            var content = page.revisions[ 0 ].content || '';

            // Normalize both space and underscore variants
            var fileWithSpaces = fileTitle.replace( /_/g, ' ' );
            var fileWithUnderscore = fileTitle.replace( / /g, '_' );
            var escSpaces = escapeRegex( fileWithSpaces );
            var escUnderscore = escapeRegex( fileWithUnderscore );

           // Locate the playlist div content
            var divRe = /(<div[^>]*class="tta-playlist"[^>]*>)([\s\S]*)(<\/div>)/;
            var mDiv = divRe.exec( content );
            if ( !mDiv ) {
                throw new Error( 'Playlist div not found in page content' );
            }

            var open = mDiv[ 1 ];
            var inner = mDiv[ 2 ];
            var close = mDiv[ 3 ];

           // Remove the matching track bullet line
            var bulletRe = new RegExp(
                '^\\s*\\*\\s*\\[\\[\\s*(?:' + escSpaces + '|' + escUnderscore + ')\\s*\\]\\][^\\n]*\\n?',
                'gm'
            );
            inner = inner.replace( bulletRe, '' );

           // Collapse excessive blank lines
            inner = inner.replace( /\n{3,}/g, '\n\n' );

           // Handle the artwork block
            var artworkRe = /<div\s+class="tta-playlist-artworks"[^>]*>([\s\S]*?)<\/div>/;
            var artworkMatch = artworkRe.exec( inner );
            var artworkInner = artworkMatch ? artworkMatch[ 1 ] : '';

            if ( artworkMatch ) {
               // Check whether the file still appears in remaining bullets
                var stillPresentRe = new RegExp(
                    '\\[\\[\\s*(?:' + escSpaces + '|' + escUnderscore + ')\\s*\\]\\]'
                );
                var stillPresent = stillPresentRe.test( inner );

                if ( !stillPresent ) {
                   // Remove spans for this file from the artwork block
                    var spanRemoveRe = new RegExp(
                        '<span[^>]*data-file="(?:' + escSpaces + '|' + escUnderscore + ')"[^>]*>\\s*<\\/span>\\s*\\n?',
                        'g'
                    );
                    var newArtworkInner = artworkInner.replace( spanRemoveRe, '' );
                    artworkInner = newArtworkInner;

                   // Drop the artwork block if nothing remains
                    if ( !/\S/.test( artworkInner ) ) {
                        inner = inner.replace( artworkRe, '' );
                    } else {
                       // Replace the artwork block with the updated version
                        inner = inner.replace(
                            artworkRe,
                            '<div class="tta-playlist-artworks" style="display:none">\n' +
                            artworkInner +
                            '</div>\n'
                        );
                    }
                }
            }

           // Recompose playlist content
           inner = inner.replace( /^\s+$/gm, '' ); // remove whitespace-only lines

           // Ensure at least one newline after the opening div
            if ( inner.charAt( 0 ) !== '\n' ) {
                inner = '\n' + inner;
            }

            var newContent = content.replace( divRe, open + inner + close );

            return api.postWithToken( 'csrf', {
                action: 'edit',
                title: playlistTitle,
                text: newContent,
                summary: 'Remove track from playlist',
                format: 'json'
            } );
        } ).catch( function ( err ) {
            console.error( '[TTA] removeTrackFromPlaylist error:', err );
            mw.notify( 'Error while removing track from playlist. Check console.', {
                type: 'error'
            } );
        } );
    }

    /**
     * Ensure the user's playlist index exists and contains the given playlist link, creating
     * a default formatted index when missing or blank.
     * @param {mw.Api} api MediaWiki API instance.
     * @param {string} username User name owning the playlist.
     * @param {string} playlistTitle Playlist page title to add.
     * @param {string} niceName Human-friendly playlist label.
     * @return {jQuery.Promise} Resolves after index is saved (or no-op if already present).
     */
    function ensurePlaylistIndex ( api, username, playlistTitle, niceName ) {
        var indexTitle = 'User:' + username + '/Playlists';
        var link = '[[' + playlistTitle + '|' + niceName + ']]';

        // Default wikitext template for a new Playlist Library
        function buildNewIndexContent () {
            return (
                '__NOTITLE__\n' +
                '__NOEDITSECTION__\n\n' +

                '{{portal header\n' +
                ' | title = My Playlist Library\n' +
                ' | notes = \'\'Your personal collection of playlists.\'\'\n' +
                '  Use the green <b>+</b> button near any track to add it to a playlist\n' +
                '  or to create a new one. {{break|2}}\n' +
                '}}\n\n' +

                '[[File:Open book.png|center|300px|link=|alt=My Playlist Library]]\n\n' +

                '<!-- TTA_PLAYLIST_LIBRARY_START -->\n' +
                '== My playlists ==\n' +
                '<!--\n' +
                'The list below is managed by the TTA Playlist gadget.\n' +
                'You can rename or delete playlists using the ⋮ menu on each playlist page.\n' +
                '-->\n' +
                '* ' + link + '\n' +
                '<!-- TTA_PLAYLIST_LIBRARY_END -->\n'
            );
        }

        return api.get( {
            action: 'query',
            prop: 'revisions',
            rvprop: 'content',
            titles: indexTitle,
            formatversion: 2,
            format: 'json'
        } ).then( function ( data ) {
            var page = data.query.pages[ 0 ];
            var content;

            if ( page.missing ) {
                // Page does not exist yet: create the standard library layout
                content = buildNewIndexContent();
            } else {
                content = page.revisions[ 0 ].content || '';

                // If the link is already present, no action needed
                if ( content.indexOf( link ) !== -1 ) {
                    return;
                }

                // If the page exists but is blank, replace it with the standard library
                if ( !/\S/.test( content ) ) {
                    content = buildNewIndexContent();
                } else {
                    // Page already populated: append a new entry at the end
                    content += '\n* ' + link + '\n';
                }
            }

            return api.postWithToken( 'csrf', {
                action: 'edit',
                title: indexTitle,
                text: content,
                summary: 'Create/update playlist index',
                format: 'json'
            } );
        } );
    }

    /**
     * Create a new playlist page with a sanitized technical title and optional cover,
     * then add it to the user's playlist index.
     * @param {mw.Api} api MediaWiki API instance.
     * @param {string} username Owner username.
     * @param {string} humanName Display title for the playlist.
     * @param {string|null} coverTitle Optional cover image title.
     * @return {jQuery.Promise} Resolves with { playlistTitle, name } after creation.
     */
    function createNewPlaylist ( api, username, humanName, coverTitle ) {
        var safeBase = String( humanName )
            .replace( /[^\p{L}\p{N}]+/gu, '_' )
            .replace( /^_+|_+$/g, '' );

        if ( !safeBase ) {
            safeBase = 'Playlist';
        }

        var stamp = new Date().toISOString()
            .replace( /[-:.TZ]/g, '' )
            .slice( 0, 14 );

        var technicalName = safeBase + '_' + stamp;
        var playlistTitle = 'User:' + username + '/Playlists/' + technicalName;

        var content =
            '__NOTITLE__ __NOEDITSECTION__\n\n' +
            '== ' + humanName + ' ==\n\n' +
            '<div class="tta-playlist" data-title="' + humanName + '"' +
            ( coverTitle ? ' data-cover="' + coverTitle + '"' : '' ) +
            '>\n' +
            '</div>\n';

        return api.postWithToken( 'csrf', {
            action: 'edit',
            title: playlistTitle,
            text: content,
            summary: 'Create playlist "' + humanName + '"',
            format: 'json'
        } ).then( function () {
            return ensurePlaylistIndex( api, username, playlistTitle, humanName )
                .then( function () {
                    return {
                        playlistTitle: playlistTitle,
                        name: humanName
                    };
                } );
        } );
    }
    mw.ttaCreateNewPlaylist = createNewPlaylist;

    /**
     * Retrieve and parse the user's playlist index page into an array of titles and names.
     * @param {mw.Api} api MediaWiki API instance.
     * @param {string} username Owner username.
     * @return {jQuery.Promise<Array<{title:string,name:string}>>} Parsed playlists.
     */
    function getUserPlaylists ( api, username ) {
        var indexTitle = 'User:' + username + '/Playlists';

        return api.get( {
            action: 'query',
            prop: 'revisions',
            rvprop: 'content',
            titles: indexTitle,
            formatversion: 2,
            format: 'json'
        } ).then( function ( data ) {
            var page = data.query.pages[ 0 ];
            var content = ( page.revisions && page.revisions.length ) ?
                ( page.revisions[ 0 ].content || '' ) :
                '';
            var list = [];

            var re = /^\*\s*\[\[([^\|\]]+)\|([^\]]+)\]\]/gm;
            var m;
            while ( ( m = re.exec( content ) ) !== null ) {
                list.push( {
                    title: m[ 1 ],
                    name: m[ 2 ]
                } );
            }

            return list;
        } );
    }

    /**
     * Save the current drag-and-drop track order back into the playlist page,
     * rebuilding both bullet lines and the hidden artwork block in the new sequence.
     * Reads the rendered playlist rows to determine order.
     * @param {mw.Api} api MediaWiki API instance.
     * @param {string} playlistTitle Playlist page title.
     * @param {jQuery} $playlistDiv Playlist DOM container.
     * @return {jQuery.Promise|undefined} Promise for the save, or undefined if no tracks.
     */
    function savePlaylistOrder ( api, playlistTitle, $playlistDiv ) {
        // 1) Read current order from rendered playlist rows
        var tracks = [];
        var $rows = $playlistDiv.find( '.tta-playlist-wrapper .tta-playlist-track' );
        if ( !$rows.length ) {
            $rows = $playlistDiv.find( '.tta-playlist-track' );
        }

        $rows.each( function () {
            var $row = $( this );
            var fileTitle =
                $row.attr( 'data-filetitle' ) ||
                $row.data( 'filetitle' ) ||
                '';

            if ( !fileTitle ) {
                return;
            }

            var extra = $.trim( $row.find( '.tta-track-extra' ).text() || '' );

        // Preserve the title exactly as shown in wikitext
            tracks.push( {
                fileTitle: fileTitle,
                extra: extra || null
            } );
        } );

        if ( !tracks.length ) {
            mw.notify( 'No tracks found to save order.', {
                type: 'warn'
            } );
            return;
        }

        // 2) Fetch playlist wikitext
        api.get( {
            action: 'query',
            prop: 'revisions',
            rvprop: 'content',
            titles: playlistTitle,
            formatversion: 2,
            format: 'json'
        } ).then( function ( data ) {
            var page = data.query.pages[ 0 ];
            if ( !page.revisions || !page.revisions.length ) {
                throw new Error( 'Playlist page not found' );
            }
            var content = page.revisions[ 0 ].content || '';

            // Find the playlist div with a greedy match to include all content
            var divRe = /(<div[^>]*class="tta-playlist"[^>]*>)([\s\S]*)(<\/div>)/;
            var mDiv = divRe.exec( content );
            if ( !mDiv ) {
                throw new Error( 'Playlist div not found in page content' );
            }

            var open = mDiv[ 1 ];
            var inner = mDiv[ 2 ];
            var close = mDiv[ 3 ];

            // 2a) Extract the existing artwork map
            var artworkRe = /<div\s+class="tta-playlist-artworks"[^>]*>([\s\S]*?)<\/div>/;
            var spanRe = /<span[^>]*data-file="([^"]+)"[^>]*data-artwork="([^"]+)"[^>]*>\s*<\/span>/g;
            var artworkMatch = artworkRe.exec( inner );
            var artworkInner = artworkMatch ? artworkMatch[ 1 ] : '';
            var mSpan;

            // Map canonical key (underscore) → { fileAttr, artAttr }
            var artworkMap = Object.create( null );

            while ( ( mSpan = spanRe.exec( artworkInner ) ) ) {
                var fileAttr = mSpan[ 1 ];
                var artAttr = mSpan[ 2 ];
                var canon = fileAttr.replace( / /g, '_' );
                artworkMap[ canon ] = {
                    fileAttr: fileAttr,
                    artAttr: artAttr
                };
            }

            // 2b) Remove old artwork block and old bullet lines
            if ( artworkMatch ) {
                inner = inner.replace( artworkRe, '' );
            }
            inner = inner.replace( /^\s*\*.*$/gm, '' );

            // 3) Rebuild bullet lines in the new order
            var lines = tracks.map( function ( t ) {
                var line = '* [[' + t.fileTitle + ']]';
                if ( t.extra ) {
                    line += ' // ' + t.extra;
                }
                return line;
            } );

            var bulletBlock = '\n' + lines.join( '\n' ) + '\n';

            // 4) Rebuild the artwork block following the track order
            var newArtworkBlock = '';
            var added = Object.create( null );

            tracks.forEach( function ( t ) {
                var canon = t.fileTitle.replace( / /g, '_' );
                var entry = artworkMap[ canon ];
                if ( entry && !added[ canon ] ) {
                    if ( !newArtworkBlock ) {
                        newArtworkBlock =
                            '<div class="tta-playlist-artworks" style="display:none">\n';
                    }
                    newArtworkBlock +=
                        '<span data-file="' + entry.fileAttr +
                        '" data-artwork="' + entry.artAttr + '"></span>\n';
                    added[ canon ] = true;
                }
            } );

            if ( newArtworkBlock ) {
                newArtworkBlock += '</div>\n';
            }

            // 5) Recompose inner content: bullets + artwork block
            var newInner = bulletBlock + newArtworkBlock;
            if ( newInner.charAt( 0 ) !== '\n' ) {
                newInner = '\n' + newInner;
            }

            var newContent = content.replace( divRe, open + newInner + close );

        // 6) Save the page
            return api.postWithToken( 'csrf', {
                action: 'edit',
                title: playlistTitle,
                text: newContent,
                summary: 'Reorder playlist tracks',
                format: 'json'
            } );
        } ).catch( function ( err ) {
            console.error( '[TTA] savePlaylistOrder error:', err );
            mw.notify( 'Error while saving playlist order. Check console.', {
                type: 'error'
            } );
        } );
    }


    // ------------------------------------------------------------
    // 3) Rename playlist (uses human title, not wgTitle)
    // ------------------------------------------------------------

    /**
     * Prompt the user for a new playlist name and update the playlist page plus index entry.
     * Falls back to existing heading/data-title or derived page name when current title is missing.
     * @param {mw.Api} api MediaWiki API instance.
     * @param {string} username Owner username.
     * @param {string} playlistTitle Playlist page to rename.
     * @return {jQuery.Promise|undefined} Promise chain for edits or undefined if cancelled.
     */
    function renamePlaylist ( api, username, playlistTitle ) {
        // 1) Read page content to derive the current human-friendly name
        return api.get( {
            action: 'query',
            prop: 'revisions',
            rvprop: 'content',
            titles: playlistTitle,
            formatversion: 2,
            format: 'json'
        } ).then( function ( data ) {
            var page = data.query.pages[ 0 ];
            if ( !page.revisions || !page.revisions.length ) {
                mw.notify( 'Cannot rename: playlist page has no content.', {
                    type: 'error'
                } );
                return;
            }

            var content = page.revisions[ 0 ].content || '';
            var currentName;

            // a) Try the first heading == ... ==
            var mHeading = content.match( /==\s*(.+?)\s*==/ );
            if ( mHeading && mHeading[ 1 ] ) {
                currentName = mHeading[ 1 ];
            } else {
                // b) Try data-title of the playlist div
                var mDiv = content.match(
                    /<div[^>]*class="tta-playlist"[^>]*data-title="([^"]*)"/
                );
                if ( mDiv && mDiv[ 1 ] ) {
                    currentName = mDiv[ 1 ];
                } else {
                    // c) Fallback: last part of the page title, replacing underscores
                    var parts = playlistTitle.split( '/' );
                    currentName = parts[ parts.length - 1 ].replace( /_/g, ' ' );
                }
            }

            // 2) Prompt for the new name using the current human title
            var newName = window.prompt( 'New playlist name:', currentName );
            if ( !newName ) {
                return;
            }
            newName = newName.trim();
            if ( !newName || newName === currentName ) {
                return;
            }

            // 3) Update page content (heading + data-title)
            content = content.replace(
                /(==\s*)(.+?)(\s*==)/,
                '$1' + newName + '$3'
            );
            content = content.replace(
                /(<div[^>]*class="tta-playlist"[^>]*data-title=")([^"]*)(")/,
                '$1' + newName + '$3'
            );

            return api.postWithToken( 'csrf', {
                action: 'edit',
                title: playlistTitle,
                text: content,
                summary: 'Rename playlist to "' + newName + '"',
                format: 'json'
            } ).then( function () {
                // 4) Update the user playlist index entry
                var indexTitle = 'User:' + username + '/Playlists';
                return api.get( {
                    action: 'query',
                    prop: 'revisions',
                    rvprop: 'content',
                    titles: indexTitle,
                    formatversion: 2,
                    format: 'json'
                } ).then( function ( data2 ) {
                    var page2 = data2.query.pages[ 0 ];
                    if ( !page2.revisions || !page2.revisions.length ) {
                        return;
                    }
                    var indexContent = page2.revisions[ 0 ].content || '';

                    var re = new RegExp(
                        '(\\*\\s*\\[\\[' + escapeRegex( playlistTitle ) + '\\|)([^\\]]+)(\\]\\])'
                    );
                    indexContent = indexContent.replace( re, '$1' + newName + '$3' );

                    return api.postWithToken( 'csrf', {
                        action: 'edit',
                        title: indexTitle,
                        text: indexContent,
                        summary: 'Rename playlist entry',
                        format: 'json'
                    } );
                } ).then( function () {
                    mw.notify(
                        'Playlist renamed to "' + newName + '".', {
                            type: 'success'
                        }
                    );
                    // Reload to refresh title and player
                    window.location.reload();
                } );
            } );
        } ).catch( function ( err ) {
            console.error( '[TTA] renamePlaylist error:', err );
            mw.notify( 'Error while renaming playlist.', {
                type: 'error'
            } );
        } );
    }

    // ------------------------------------------------------------
    // 3b) Helpers for index management and deletions
    // ------------------------------------------------------------

    /**
     * Remove the playlist link from the user's playlist index page, if present.
     * Collapses excessive blank lines after deletion.
     * @param {mw.Api} api MediaWiki API instance.
     * @param {string} username Owner username.
     * @param {string} playlistTitle Playlist page title to remove.
     * @return {jQuery.Promise|undefined} Promise for the edit or undefined if unchanged.
     */
    function removePlaylistFromIndex ( api, username, playlistTitle ) {
        var indexTitle = 'User:' + username + '/Playlists';

        return api.get( {
            action: 'query',
            prop: 'revisions',
            rvprop: 'content',
            titles: indexTitle,
            formatversion: 2,
            format: 'json'
        } ).then( function ( data ) {
            var page = data.query.pages[ 0 ];
            if ( !page.revisions || !page.revisions.length ) {
                return;
            }
            var content = page.revisions[ 0 ].content || '';

            // Remove the line containing [[playlistTitle|...]]
            var re = new RegExp(
                '^\\*\\s*\\[\\[' + escapeRegex( playlistTitle ) + '\\|[^\\]]+\\]\\]\\s*\\n?',
                'm'
            );
            var newContent = content.replace( re, '' );

            // Ripulisce eventuali linee vuote multiple
            newContent = newContent.replace( /\n{3,}/g, '\n\n' );

            if ( newContent === content ) {
                return;
            }

            return api.postWithToken( 'csrf', {
                action: 'edit',
                title: indexTitle,
                text: newContent,
                summary: 'Remove playlist from profile',
                format: 'json'
            } );
        } );
    }

    /**
     * Attempt a hard delete of the playlist page (requires appropriate rights) and update the index.
     * Provides user notifications for success and permission errors.
     * @param {mw.Api} api MediaWiki API instance.
     * @param {string} username Owner username.
     * @param {string} playlistTitle Playlist page to delete.
     * @return {jQuery.Promise} Promise chain for delete + index edit.
     */
    function deletePlaylistPermanently ( api, username, playlistTitle ) {
        // Attempt page deletion (works for sysops; others may hit permission errors).
        return api.postWithToken( 'csrf', {
            action: 'delete',
            title: playlistTitle,
            reason: 'Delete playlist permanently',
            format: 'json'
        } ).then( function () {
            return removePlaylistFromIndex( api, username, playlistTitle );
        } ).then( function () {
            mw.notify(
                'Playlist deleted permanently.', {
                    type: 'success'
                }
            );
            // Redirect back to the playlist index page
            window.location.href = mw.util.getUrl( 'User:' + username + '/Playlists' );
        } ).catch( function ( err ) {
            console.error( '[TTA] deletePlaylist error:', err );
            var msg = 'Error while deleting playlist.';
            if ( err && err.error && err.error.info ) {
                msg += ' ' + err.error.info;
            }
            mw.notify( msg, {
                type: 'error'
            } );
        } );
    }

    /**
     * Soft-delete for normal users: replace content with a stub and remove from the index
     * without issuing a hard delete action.
     * @param {mw.Api} api MediaWiki API instance.
     * @param {string} username Owner username.
     * @param {string} playlistTitle Playlist page to soft-delete.
     * @return {jQuery.Promise} Promise chain for edit + index removal.
     */
    function softDeletePlaylistForUser ( api, username, playlistTitle ) {
        var placeholder =
            '__NOTITLE__ __NOINDEX__\n\n' +
            "''This playlist has been deleted by its owner.''\n";

        return api.postWithToken( 'csrf', {
            action: 'edit',
            title: playlistTitle,
            text: placeholder,
            summary: 'Soft-delete playlist by owner',
            format: 'json'
        } ).then( function () {
            return removePlaylistFromIndex( api, username, playlistTitle );
        } ).then( function () {
            mw.notify(
                'Playlist removed from your library.', {
                    type: 'success'
                }
            );
            // Redirect back to the playlist index page
            window.location.href = mw.util.getUrl( 'User:' + username + '/Playlists' );
        } ).catch( function ( err ) {
            console.error( '[TTA] softDeletePlaylistForUser error:', err );
            var msg = 'Error while deleting playlist.';
            if ( err && err.error && err.error.info ) {
                msg += ' ' + err.error.info;
            }
            mw.notify( msg, {
                type: 'error'
            } );
        } );
    }


    /**
     * Add this playlist to the user's playlist index if not already listed.
     * Creates the index page if missing and preserves existing content when present.
     * @param {mw.Api} api MediaWiki API instance.
     * @param {string} userName Username (e.g., "WikiSysop").
     * @param {string} playlistPage Playlist page title to link.
     * @param {string} playlistLabel Human-readable label to show.
     * @return {jQuery.Promise|undefined} Promise for the edit, or undefined when already present.
     */
    function addPlaylistToIndex ( api, userName, playlistPage, playlistLabel ) {
        if ( !userName ) {
            return $.Deferred().reject( 'no-user' ); // no logged-in user
        }

        var indexTitle = 'User:' + userName + '/Playlists';

        return api.get( {
            action: 'query',
            prop: 'revisions',
            rvprop: 'content',
            titles: indexTitle,
            formatversion: 2,
            format: 'json'
        } ).then( function ( data ) {
            var page = data.query.pages[ 0 ];
            var content = '';
            var exists = true;

            if ( page.missing ) {
                exists = false;
            } else if ( page.revisions && page.revisions.length ) {
                content = page.revisions[ 0 ].content || '';
            }

            // linea link, tipo: * [[User:Foo/Playlists/Bar|Featured Tune]]
            var safeLabel = playlistLabel || playlistPage;
            var linkLine = '* [[' + playlistPage + '|' + safeLabel + ']]';

        // Avoid duplicates: look for any line with that page
            var escapedPage = escapeRegex( playlistPage.replace( / /g, '_' ) );
            var re = new RegExp( '\\*\\s*\\[\\[' + escapedPage + '(\\|[^\\]]*)?\\]\\]' );

        if ( re.test( content ) ) {
            // Already present, nothing to do
            return;
        }

        if ( !exists ) {
            // Brand new index page
            content =
                    '__NOTITLE__ __NOEDITSECTION__\n\n' +
                    '== My playlists ==\n\n' +
                    linkLine + '\n';
            } else {
                // append in fondo (con una riga vuota di sicurezza)
                if ( content && content[ content.length - 1 ] !== '\n' ) {
                    content += '\n';
                }
                content += linkLine + '\n';
            }

            return api.postWithToken( 'csrf', {
                action: 'edit',
                title: indexTitle,
                text: content,
                summary: 'Add playlist to user index',
                format: 'json'
            } );
        } );
    }


    // ------------------------------------------------------------
    // 4) OOUI "Add to playlist" dialog + confirmation helper
    // ------------------------------------------------------------

    var ttaPlaylistWindowManager;

    /**
     * Lazy-create and cache the OOUI window manager used by this gadget.
     * @return {OO.ui.WindowManager} Shared window manager instance.
     */
    function getTtaPlaylistWindowManager () {
        if ( !ttaPlaylistWindowManager ) {
            ttaPlaylistWindowManager = new OO.ui.WindowManager();
            $( document.body ).append( ttaPlaylistWindowManager.$element );
        }
        return ttaPlaylistWindowManager;
    }

    /**
     * Show an OOUI confirmation/choice dialog and resolve with the chosen action.
     * Falls back to OK/Cancel when no custom actions are supplied.
     * @param {Object} config Dialog configuration (title, message, actions, labels).
     * @return {jQuery.Promise<string|null>} Selected action name or null.
     */
    function openConfirmDialog ( config ) {
        var wm = getTtaPlaylistWindowManager();
        var messageDialog = new OO.ui.MessageDialog();

        wm.addWindows( [ messageDialog ] );

        // If no custom actions are provided, fall back to Cancel / OK
        var actions = config.actions || [ {
            action: 'cancel',
            label: config.cancelLabel || 'Cancel',
            flags: [ 'safe', 'close' ]
        }, {
            action: 'accept',
            label: config.okLabel || 'OK',
            flags: config.okFlags || [ 'primary', 'progressive' ]
        } ];

        var winPromise = wm.openWindow( messageDialog, {
            title: config.title || 'Confirm',
            message: config.message || '',
            actions: actions
        } );

        // Return the clicked action string (or null)
        return winPromise.closed.then( function ( data ) {
            return data && data.action || null;
        } );
    }

    /**
     * OOUI process dialog for adding tracks to existing or new playlists.
     * Manages tabbed UI state, user playlist list, and track metadata.
     * @param {Object} config Dialog configuration containing trackMeta.
     */
    function TtaPlaylistDialog ( config ) {
        TtaPlaylistDialog.super.call( this, config );
        this.trackMeta = config.trackMeta || {};
        this.api = new mw.Api();
        this.username = mw.config.get( 'wgUserName' );
        this.chosenPlaylist = null; // { title, name } from the custom list
        this.$existingList = null; // DOM container for existing playlists
    }
    OO.inheritClass( TtaPlaylistDialog, OO.ui.ProcessDialog );

    TtaPlaylistDialog.static.name = 'ttaPlaylistDialog';
    TtaPlaylistDialog.static.title = 'Add to playlist';
    TtaPlaylistDialog.static.closeAction = 'cancel'; // Explicitly treat close as cancel for this dialog
    TtaPlaylistDialog.static.actions = [ {
        action: 'cancel',
        label: 'Cancel',
        flags: [ 'safe', 'close' ]
    }, {
        action: 'add',
        label: 'Add',
        flags: [ 'primary', 'progressive' ]
    } ];

    /**
     * Build dialog UI: tabs for existing playlists and creating a new one,
     * wiring inputs, checkboxes, and list container.
     */
    TtaPlaylistDialog.prototype.initialize = function () {
        TtaPlaylistDialog.super.prototype.initialize.call( this );

        var dialog = this;

        // ---- Existing playlists tab (custom list) ----
        this.$existingList = $( '<div>' ).addClass( 'tta-playlist-list' );

        this.existingPanel = new OO.ui.TabPanelLayout( 'existing', {
            label: 'Existing playlists',
            padded: true,
            expanded: false
        } );

        this.existingPanel.$element.append( this.$existingList );

        // ---- Create new playlist tab ----
        this.newNameInput = new OO.ui.TextInputWidget( {
            placeholder: 'New playlist name'
        } );

        this.useArtworkCheckbox = new OO.ui.CheckboxInputWidget( {
            selected: true
        } );

        this.useArtworkField = new OO.ui.FieldLayout(
            this.useArtworkCheckbox, {
                label: 'Use this track artwork as cover',
                align: 'inline'
            }
        );

        this.newPlaylistPanel = new OO.ui.TabPanelLayout( 'create', {
            label: 'Create new playlist',
            padded: true,
            expanded: false
        } );

        this.newPlaylistPanel.$element.append(
            new OO.ui.FieldLayout( this.newNameInput, {
                label: 'Playlist name',
                align: 'top'
            } ).$element,
            this.useArtworkField.$element
        );

        // ---- IndexLayout con le due tab ----
        this.indexLayout = new OO.ui.IndexLayout( {
            expanded: false
        } );
        this.indexLayout.addTabPanels( [
            this.existingPanel,
            this.newPlaylistPanel
        ] );

        this.$body.append( this.indexLayout.$element );
    };

    /**
     * Fixed body height so the dialog layout remains stable.
     */
    TtaPlaylistDialog.prototype.getBodyHeight = function () {
        return 260;
    };

    /**
     * Load existing playlists for the user and populate the custom list in the dialog.
     * @return {OO.ui.Process} Setup process promise.
     */
    TtaPlaylistDialog.prototype.getSetupProcess = function ( data ) {
        var dialog = this;

        return TtaPlaylistDialog.super.prototype.getSetupProcess.call( this, data )
            .next( function () {
                return getUserPlaylists( dialog.api, dialog.username )
                    .then( function ( list ) {
                        dialog.chosenPlaylist = null;
                        dialog.$existingList.empty();

                        if ( !list.length ) {
                            dialog.$existingList.append(
                                $( '<p>' ).text( 'You have no playlists yet.' )
                            );
                            return;
                        }

                        list.forEach( function ( pl ) {
                            var $item = $( '<div>' )
                                .addClass( 'tta-playlist-item' )
                                .text( pl.name )
                                .data( 'ttaPlaylist', pl );

                            $item.on( 'click', function () {
                                dialog.$existingList
                                    .find( '.tta-playlist-item--selected' )
                                    .removeClass( 'tta-playlist-item--selected' );
                                $item.addClass( 'tta-playlist-item--selected' );
                                dialog.chosenPlaylist = pl;
                                console.log( '[TTA] chosenPlaylist =', pl );
                            } );

                            dialog.$existingList.append( $item );
                        } );
                    } );
            } );
    };

    /**
     * Handle dialog actions: add to existing playlist, create new playlist, or close.
     * Validates selections and delegates to playlist creation/append helpers.
     * @param {string} action Action name triggered by the button.
     * @return {OO.ui.Process} Process for the chosen action.
     */
    TtaPlaylistDialog.prototype.getActionProcess = function ( action ) {
        var dialog = this;

        // 1) Caso speciale: pulsante "Add"
        if ( action === 'add' ) {
            return new OO.ui.Process( function () {
                var track = dialog.trackMeta;
                var useArtwork = dialog.useArtworkCheckbox.isSelected();
                var newName = dialog.newNameInput.getValue().trim();
                var api = dialog.api;
                var username = dialog.username;

                var activeName = dialog.indexLayout.getCurrentTabPanelName();

                // ---- Existing playlists ----
                if ( activeName === 'existing' ) {
                    var pl = dialog.chosenPlaylist; // { title, name }

                    console.log( '[TTA] Add (existing) – chosenPlaylist =', pl );

                    if ( !pl ) {
                        mw.notify(
                            'Select a playlist or switch to "Create new playlist".', {
                                type: 'error'
                            }
                        );
                        return;
                    }

                    return appendTrackToPlaylist(
                        api,
                        pl.title,
                        track.fileTitle,
                        track.extra,
                        track.artworkTitle // track artwork
                    ).then( function () {
                        mw.notify(
                            'Track added to "' + pl.name + '".', {
                                type: 'success'
                            }
                        );
                        dialog.close( {
                            action: 'done'
                        } );
                    } );
                }

                // ---- Create new playlist ----
                if ( activeName === 'create' ) {
                    if ( !newName ) {
                        mw.notify( 'Please enter a playlist name.', {
                            type: 'error'
                        } );
                        dialog.newNameInput.focus();
                        return;
                    }

                    var coverTitle = null;
                    if ( useArtwork && track.artworkTitle ) {
                        coverTitle = track.artworkTitle;
                    }

                    return createNewPlaylist(
                        api,
                        username,
                        newName,
                        coverTitle
                    ).then( function ( info ) {
                        return appendTrackToPlaylist(
                            api,
                            info.playlistTitle,
                            track.fileTitle,
                            track.extra,
                            track.artworkTitle // track artwork
                        ).then( function () {
                            mw.notify(
                                'Playlist "' + info.name + '" created and track added.', {
                                    type: 'success'
                                }
                            );
                            dialog.close( {
                                action: 'done'
                            } );
                        } );
                    } );
                }

                mw.notify( 'Unknown action.', {
                    type: 'error'
                } );
            } );
        }

        // 2) All other actions (X, Cancel, ESC, etc.) simply close the dialog
        return new OO.ui.Process( function () {
            // 'action' may be 'cancel', 'close' or undefined; we just close cleanly.
            dialog.close( {
                action: action || 'cancel'
            } );
        } );
    };

    /**
     * Open the add-to-playlist dialog for the given track metadata.
     * @param {string} fileTitle Track file title.
     * @param {string|null} extra Optional extra info.
     * @param {string|null} artworkTitle Optional artwork title.
     */
    function openAddToPlaylistDialog ( fileTitle, extra, artworkTitle ) {
        var wm = getTtaPlaylistWindowManager();

        var dialog = new TtaPlaylistDialog( {
            size: 'medium',
            trackMeta: {
                fileTitle: fileTitle,
                extra: extra,
                artworkTitle: artworkTitle
            }
        } );

        wm.addWindows( [ dialog ] );
        wm.openWindow( dialog );
    }
    mw.ttaOpenAddToPlaylistDialog = openAddToPlaylistDialog;

    // ------------------------------------------------------------
    // 5) Owner UI: remove track + options menu on playlist pages
    // ------------------------------------------------------------

    /**
     * Attach trash buttons to playlist tracks, reading file titles from DOM or cached data.
     * Prompts for confirmation before removing the track from the playlist page.
     * @param {mw.Api} api MediaWiki API instance.
     * @param {string} playlistTitle Playlist page title.
     * @param {jQuery} $playlistDiv Playlist DOM container.
     */
    function attachRemoveButtons ( api, playlistTitle, $playlistDiv ) {
        var fileTitles = $playlistDiv.data( 'ttaPlaylistFiles' ) || [];

        // First try modern card tracks
        var $tracks = $playlistDiv.find( '.tta-playlist-wrapper .tta-playlist-track' );
        if ( !$tracks.length ) {
            // Fallback: tracks may be directly under .tta-playlist
            $tracks = $playlistDiv.find( '.tta-playlist-track' );
        }
        if ( !$tracks.length ) {
            // Legacy fallback: no player, use raw <li> elements
            $tracks = $playlistDiv.find( 'li' );
        }

        $tracks.each( function ( index ) {
            var $item = $( this );

            // Prevent double binding
            if ( $item.data( 'ttaRemoveBound' ) ) {
                return;
            }

            var fileTitle =
                $item.attr( 'data-filetitle' ) ||
                $item.data( 'filetitle' ) ||
                fileTitles[ index ] ||
                null;

            // Fallback: read a File: link inside the item if present
            if ( !fileTitle ) {
                var $fileLink = $item.find( 'a[href*="File:"]' ).first();
                if ( $fileLink.length ) {
                    var href = $fileLink.attr( 'href' ) || '';
                    var m = href.match( /\/wiki\/([^?#]+)/ );
                    if ( m ) {
                        fileTitle = decodeURIComponent( m[ 1 ] );
                    }
                }
            }

            if ( !fileTitle ) {
                return;
            }

            var $btn = $( '<button>' )
                .attr( 'type', 'button' )
                .addClass( 'tta-remove-track-btn' )
                .text( '🗑' );

            $btn.on( 'click', function ( e ) {
                e.preventDefault();
                e.stopPropagation();

                openConfirmDialog( {
                    title: 'Remove track',
                    message: 'Remove this track from the playlist?',
                    actions: [ {
                        action: 'cancel',
                        label: 'Cancel',
                        flags: [ 'safe', 'close' ]
                    }, {
                        action: 'remove',
                        label: 'Remove',
                        flags: [ 'primary', 'destructive' ]
                    } ]
                } ).then( function ( action ) {
                    if ( action !== 'remove' ) {
                        return;
                    }

                    removeTrackFromPlaylist( api, playlistTitle, fileTitle )
                        .then( function () {
                            mw.notify( 'Track removed from playlist.', {
                                type: 'success'
                            } );
                            $item.remove();
                        } )
                        .catch( function ( err ) {
                            console.error( '[TTA] removeTrack error:', err );
                            mw.notify( 'Error while removing track.', {
                                type: 'error'
                            } );
                        } );
                } );
            } );

            $item.append( $btn );
            $item.data( 'ttaRemoveBound', true );
        } );
    }

    /**
     * Enhance playlist pages for the owner: cache track titles, add remove buttons,
     * and render the owner toolbar with menu actions (rename, delete, save order, etc.).
     * @param {jQuery} $root Optional root scope; defaults to document.
     */
    function enhancePlaylistOwnerUI ( $root ) {
        if ( !$root || !$root.jquery ) {
            $root = $( document );
        }

        var userName = mw.config.get( 'wgUserName' );
        var pageName = mw.config.get( 'wgPageName' ); // e.g., "User:WikiSysop/Playlists/Harpers_..."
        var prefix = 'User:' + userName + '/Playlists/';
        // Current user groups (e.g., ["*", "user", "autoconfirmed", "sysop", ...])
        var userGroups = mw.config.get( 'wgUserGroups' ) || [];
        var isSysop = userGroups.indexOf( 'sysop' ) !== -1;

        if ( !userName || !pageName ) {
            return;
        }

        // Locate the primary playlist on the page
        var $playlistDiv = $root.find( '.tta-playlist' ).first();
        if ( !$playlistDiv.length ) {
            console.log( '[TTA] ownerUI: nessuna .tta-playlist trovata nella pagina' );
            return;
        }

        // Avoid rerunning if the hook fires multiple times
        if ( $playlistDiv.data( 'ttaOwnerUiBound' ) ) {
            return;
        }
        $playlistDiv.data( 'ttaOwnerUiBound', true );

        // --- 1) Immediately collect file titles from the raw UL
        var fileTitles = [];
        $playlistDiv.find( 'li' ).each( function () {
            var $li = $( this );
            var $fileLink = $li.find( 'a[href*="File:"]' ).first();
            if ( !$fileLink.length ) {
                return;
            }

            var href = $fileLink.attr( 'href' ) || '';
            var m = href.match( /\/wiki\/([^?#]+)/ );
            if ( !m ) {
                return;
            }
            var fileTitle = decodeURIComponent( m[ 1 ] ); // e.g., "File:Napoleon_crossing_the_Rhine.mp3"
            fileTitles.push( fileTitle );
        } );
        $playlistDiv.data( 'ttaPlaylistFiles', fileTitles );

        var isOwner = pageName.indexOf( prefix ) === 0;
        console.log(
            '[TTA] ownerUI:',
            'pageName=', pageName,
            'prefix=', prefix,
            'isOwner=', isOwner
        );

        // --- 2) After the player renders, add trash buttons and the owner toolbar/menu
        setTimeout( function () {
            var api = new mw.Api();


            // Attach trash buttons on tracks
            attachRemoveButtons( api, pageName, $playlistDiv );


            // If not the owner, skip rendering the owner bar (future: allow adding others' playlists)
            if ( !isOwner ) {
                return;
            }

            // Owner bar label + menu
            var $ownerBar = $( '<div>' )
                .addClass( 'tta-playlist-ownerbar' );

            var $ownerLabel = $( '<span>' )
                .addClass( 'tta-playlist-ownerbar-label' )
                .text( 'Your playlist' );

            // "+" button to add/restore the playlist in the user's library
            var addBtn = new OO.ui.ButtonWidget( {
                label: '+',
                title: 'Add this playlist to your library',
                framed: false,
                classes: [ 'tta-playlist-add-button' ]
            } );

            addBtn.on( 'click', function () {
                openConfirmDialog( {
                    title: 'Add to your library',
                    message: 'Add this playlist to your personal playlists page?',
                    actions: [ {
                        action: 'cancel',
                        label: 'Cancel',
                        flags: [ 'safe', 'close' ]
                    }, {
                        action: 'add',
                        label: 'Add to my library',
                        flags: [ 'primary' ]
                    } ]
                } ).then( function ( action ) {
                    if ( action === 'add' ) {
                        var playlistLabel = $playlistDiv.data( 'title' ) || pageName;
                        addPlaylistToIndex( api, userName, pageName, playlistLabel );
                    }
                } );
            } );


            // --- Menu items ---

            // "Save order" button
            var saveOrderBtn = new OO.ui.ButtonWidget( {
                label: '↕ Save order',
                framed: false,
                classes: [ 'tta-playlist-menu-item' ]
            } );

            // "Rename" button
            var renameBtn = new OO.ui.ButtonWidget( {
                label: '✏ Rename',
                framed: false,
                classes: [ 'tta-playlist-menu-item' ]
            } );

            // "Remove from profile" button
            var removeProfileBtn = new OO.ui.ButtonWidget( {
                label: '☆ Remove from profile',
                framed: false,
                classes: [ 'tta-playlist-menu-item' ]
            } );

            // "Delete permanently" button
            var deleteBtn = new OO.ui.ButtonWidget( {
                label: '✕ Delete permanently',
                framed: false,
                classes: [ 'tta-playlist-menu-item' ]
            } );

            // Vertical menu container
            var $innerMenu = $( '<div>' )
                .addClass( 'tta-playlist-menu' )
                .append( saveOrderBtn.$element )
                .append( renameBtn.$element )
                .append( removeProfileBtn.$element )
                .append( deleteBtn.$element );

            // Popup containing the menu
            var popupWidget = new OO.ui.PopupWidget( {
                $content: $innerMenu,
                padded: false,
                align: 'right',
                autoClose: true,
                head: false,
                classes: [ 'tta-playlist-popup' ]
            } );

            // ⋮ button to toggle the popup
            var menuButton = new OO.ui.ButtonWidget( {
                label: '⋮',
                title: 'Playlist options',
                framed: false,
                classes: [ 'tta-playlist-menu-button' ]
            } );

            menuButton.on( 'click', function () {
                popupWidget.toggle();
            } );

            // --- Menu button actions ---

            // Rename
            renameBtn.on( 'click', function () {
                popupWidget.toggle( false );
                renamePlaylist( api, userName, pageName );
            } );

            // Remove from profile
            removeProfileBtn.on( 'click', function () {
                popupWidget.toggle( false );

                openConfirmDialog( {
                    title: 'Remove from profile',
                    message: 'Remove this playlist from your profile? The playlist page will stay accessible if someone has the direct link.',
                    actions: [ {
                        action: 'keep',
                        label: 'Cancel',
                        flags: [ 'safe', 'close' ]
                    }, {
                        action: 'remove',
                        label: 'Remove from profile',
                        flags: [ 'primary', 'destructive' ]
                    } ]
                } ).then( function ( action ) {
                    if ( action === 'remove' ) {
                        removePlaylistFromIndex( api, userName, pageName );
                    }
                } );
            } );

            // Delete (hard for sysops, soft for normal users)
            deleteBtn.on( 'click', function () {
                popupWidget.toggle( false );

                var title = isSysop ? 'Delete permanently' : 'Delete playlist';
                var message = isSysop ?
                    'Delete this playlist page permanently? This cannot be undone.' :
                    'Delete this playlist from your library? The page content will be replaced by a small stub and removed from your library.';

                openConfirmDialog( {
                    title: title,
                    message: message,
                    actions: [ {
                        action: 'keep',
                        label: 'Cancel',
                        flags: [ 'safe', 'close' ]
                    }, {
                        action: 'delete',
                        label: isSysop ? 'Delete' : 'Delete playlist',
                        flags: [ 'primary', 'destructive' ]
                    } ]
                } ).then( function ( action ) {
                    if ( action === 'delete' ) {
                        if ( isSysop ) {
                            // Hard delete via action=delete
                        deletePlaylistPermanently( api, userName, pageName );
                    } else {
                            // Soft delete: edit + remove from index
                        softDeletePlaylistForUser( api, userName, pageName );
                    }
                    }
                } );
            } );


            // Save order
            saveOrderBtn.on( 'click', function () {
                popupWidget.toggle( false );

                mw.notify( 'Saving new track order…', {
                    type: 'info'
                } );

                savePlaylistOrder( api, pageName, $playlistDiv )
                    .then( function () {
                        mw.notify( 'Track order saved.', {
                            type: 'success'
                        } );
                        // Optional: reload the page to re-render from the updated markup
                        // location.reload();
                    } )
                    .catch( function ( err ) {
                        console.error( '[TTA] savePlaylistOrder error:', err );
                        mw.notify( 'Error while saving track order.', {
                            type: 'error'
                        } );
                    } );
            } );


            // Button container: "+" and ⋮
            var $menuContainer = $( '<span>' )
                .addClass( 'tta-playlist-menu-container' )
                .append( addBtn.$element )
                .append( menuButton.$element )
                .append( popupWidget.$element );

            $ownerBar.append( $ownerLabel, $menuContainer );

            // Insert the bar at the start of the playlist wrapper (if present)
            var $wrapper = $playlistDiv.find( '.tta-playlist-wrapper' ).first();

            if ( $wrapper.length ) {
                // Place the bar as the first row inside the wrapper
                $wrapper.prepend( $ownerBar );
            } else {
                // Fallback: if the wrapper is missing, use legacy placement
                $playlistDiv.before( $ownerBar );
            }

            console.log( '[TTA] ownerUI: owner bar + menu added' );
        }, 1000 ); // same delay as trash buttons
    }

    // ------------------------------------------------------------
    // Init gadget
    // ------------------------------------------------------------

    /**
     * Entry point: enhance embeds and owner UI on initial load and subsequent page content updates.
     * @param {jQuery} $content Optional root element provided by MediaWiki hook.
     */
    function init ( $content ) {
        if ( !$content || !$content.jquery ) {
            $content = $( document );
        }
        enhanceEmbeds( $content ); // bottone ♪ +
        enhancePlaylistOwnerUI( $content ); // remove buttons and menu on user playlists
    }

    $( function () {
        init();
    } );

    mw.hook( 'wikipage.content' ).add( init );

}( mediaWiki, jQuery ) );
