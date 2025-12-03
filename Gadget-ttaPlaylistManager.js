/* global mediaWiki, jQuery */
( function ( mw, $ ) {
    'use strict';
    console.log( 'ttaPlaylist Manager gadget v2.12.38 loaded' );

    // Solo per utenti loggati
    var username = mw.config.get( 'wgUserName' );
    if ( !username ) {
        return;
    }

    // Stili per lista playlist in dialog e bottoni gestione
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

    // Helper per regex
    function escapeRegex( s ) {
        return String( s ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
    }
	
	


    // ------------------------------------------------------------
    // 1) Bottone ♪ + sui FeaturedTunes
    // ------------------------------------------------------------

    function enhanceEmbeds( $root ) {
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

            // Extra (es. "[https://... The City Waites]") -> "The City Waites"
            var extraRaw = $embed.data( 'extra' ) || '';
            var extra = extraRaw;
            if ( extraRaw ) {
                var m = String( extraRaw ).match( /\[(?:[^\s]+)\s+([^\]]+)\]/ );
                if ( m ) {
                    extra = m[ 1 ];
                }
            }

            // Artwork (es. "File:Wit_and_Mirth.png")
            var artworkTitle = $embed.data( 'artwork' ) || null;

		var $btnWrapper = $( '<div>' )
		    .addClass( 'tta-add-to-playlist-wrapper' );

		var $btn = $( '<button>' )
		    .attr( 'type', 'button' )
		    .attr( 'title', 'Add this track to a playlist' )
		    .addClass( 'tta-add-to-playlist' )
		    .text( '+' );

            // Sempre modalità "dialog"
            $btn.on( 'click', function () {
                openAddToPlaylistDialog( fileTitle, extra, artworkTitle );
            } );

            $btnWrapper.append( $btn );
            $embed.append( $btnWrapper );
        } );
    }

    // ------------------------------------------------------------
    // 2) Funzioni di scrittura playlist lato wiki
    // ------------------------------------------------------------

   /**
    * Aggiunge una riga alla playlist:
    *   * [[File:XXX.mp3]] // Extra <!--ART:File:Copertina.jpg-->
    */
   /**
    * Aggiunge una riga alla playlist:
    *   * [[File:XXX.mp3]] // Extra
    */
   function appendTrackToPlaylist( api, playlistTitle, fileTitle, extra, artworkTitle ) {
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

           // Se la pagina è vuota, crea lo scheletro base
           if ( !/\S/.test( content ) ) {
               var parts = playlistTitle.split( '/' );
               var niceName = parts[ parts.length - 1 ].replace( /_/g, ' ' );
               content =
                   '__NOTITLE__\n\n' +
                   '== ' + niceName + ' ==\n\n' +
                   '<div class="tta-playlist" data-title="' + niceName + '">\n' +
                   '</div>\n';
           }

           // Normalizza titolo file / artwork
           if ( fileTitle.indexOf( 'File:' ) !== 0 ) {
               fileTitle = 'File:' + fileTitle;
           }
           if ( artworkTitle && artworkTitle.indexOf( 'File:' ) !== 0 ) {
               artworkTitle = 'File:' + artworkTitle;
           }

           // Trova il <div class="tta-playlist" ...> e il suo contenuto
           // 🔧 FIX: uso [\s\S]* (greedy), non [\s\S]*? (non-greedy),
           // così prendo TUTTO il contenuto della playlist, inclusi i blocchi artworks e la chiusura giusta.
           var divRe = /(<div[^>]*class="tta-playlist"[^>]*>)([\s\S]*)(<\/div>)/;
           content = content.replace( divRe, function ( _all, open, inner, close ) {

               // 1) Raccogli TUTTI gli span artwork esistenti (anche da più blocchi) in una mappa
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

               // Aggiungi / aggiorna l'artwork del file corrente
               if ( artworkTitle ) {
                   var safeFile = fileTitle.replace( /"/g, '&quot;' );
                   var safeArtwork = artworkTitle.replace( /"/g, '&quot;' );
                   artworkMap[ safeFile ] = safeArtwork;
               }

               // 2) Rimuovi TUTTI i vecchi blocchi artworks dal contenuto
               inner = inner.replace( artworkRe, '' );

               // 3) Aggiungi la nuova riga della playlist in fondo alle righe esistenti
               var trimmed = inner.replace( /\s+$/, '' ); // togli spazi finali
               var line = '* [[' + fileTitle + ']]';
               if ( extra ) {
                   line += ' // ' + extra;
               }

               var bullets = trimmed;
               if ( bullets && !/\n$/.test( bullets ) ) {
                   bullets += '\n';
               }
               bullets += line + '\n';

               // 4) Ricostruisci UN SOLO blocco artworks alla fine, se ci sono voci in mappa
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

               // 5) Ricompone il div playlist normalizzato
               var newInner = '\n' + bullets + artworkBlock;
               return open + newInner + close;
           } );

           // Salva la pagina
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

   // Rimuove un brano dalla playlist e aggiorna il blocco artworks
   // Rimuove un brano dalla playlist e aggiorna il blocco artworks
   function removeTrackFromPlaylist( api, playlistTitle, fileTitle ) {
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

           // Normalizza: variante con spazi e con underscore
           var fileWithSpaces = fileTitle.replace( /_/g, ' ' );
           var fileWithUnderscore = fileTitle.replace( / /g, '_' );
           var escSpaces = escapeRegex( fileWithSpaces );
           var escUnderscore = escapeRegex( fileWithUnderscore );

           // Trova il blocco <div class="tta-playlist" ...>...</div>
           var divRe = /(<div[^>]*class="tta-playlist"[^>]*>)([\s\S]*)(<\/div>)/;
           var mDiv = divRe.exec( content );
           if ( !mDiv ) {
               throw new Error( 'Playlist div not found in page content' );
           }

           var open = mDiv[ 1 ];
           var inner = mDiv[ 2 ];
           var close = mDiv[ 3 ];

           // 1) Rimuovi la riga * [[File:...]] corrispondente
           var bulletRe = new RegExp(
               '^\\s*\\*\\s*\\[\\[\\s*(?:' + escSpaces + '|' + escUnderscore + ')\\s*\\]\\][^\\n]*\\n?',
               'gm'
           );
           inner = inner.replace( bulletRe, '' );

           // Normalizza righe vuote in eccesso
           inner = inner.replace( /\n{3,}/g, '\n\n' );

           // 2) Gestisci il blocco artworks
           var artworkRe = /<div\s+class="tta-playlist-artworks"[^>]*>([\s\S]*?)<\/div>/;
           var artworkMatch = artworkRe.exec( inner );
           var artworkInner = artworkMatch ? artworkMatch[ 1 ] : '';

           if ( artworkMatch ) {
               // Controlla se il file esiste ancora in qualche altra riga *
               var stillPresentRe = new RegExp(
                   '\\[\\[\\s*(?:' + escSpaces + '|' + escUnderscore + ')\\s*\\]\\]'
               );
               var stillPresent = stillPresentRe.test( inner );

               if ( !stillPresent ) {
                   // Rimuovi eventuali span per questo file dal blocco artworks
                   var spanRemoveRe = new RegExp(
                       '<span[^>]*data-file="(?:' + escSpaces + '|' + escUnderscore + ')"[^>]*>\\s*<\\/span>\\s*\\n?',
                       'g'
                   );
                   var newArtworkInner = artworkInner.replace( spanRemoveRe, '' );
                   artworkInner = newArtworkInner;

                   // Se non resta nulla, elimina completamente il blocco artworks
                   if ( !/\S/.test( artworkInner ) ) {
                       inner = inner.replace( artworkRe, '' );
                   } else {
                       // Sostituisci il blocco artworks con quello aggiornato
                       inner = inner.replace(
                           artworkRe,
                           '<div class="tta-playlist-artworks" style="display:none">\n' +
                           artworkInner +
                           '</div>\n'
                       );
                   }
               }
           }

           // 3) Ricompone il contenuto della playlist
           inner = inner.replace( /^\s+$/gm, '' ); // rimuovi righe solo spazi

           // garantisci almeno un newline dopo il <div ...>
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
           mw.notify( 'Error while removing track from playlist. Check console.', { type: 'error' } );
       } );
   }

	function ensurePlaylistIndex( api, username, playlistTitle, niceName ) {
	    var indexTitle = 'User:' + username + '/Playlists';
	    var link = '[[' + playlistTitle + '|' + niceName + ']]';

	    // Wikitext "standard" per una nuova Playlist Library
	    function buildNewIndexContent() {
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
	            // La pagina non esiste ancora: creiamo la Library "bella"
	            content = buildNewIndexContent();
	        } else {
	            content = page.revisions[ 0 ].content || '';

	            // Se il link c'è già, non facciamo nulla
	            if ( content.indexOf( link ) !== -1 ) {
	                return;
	            }

	            // Se la pagina esiste ma è vuota / whitespace-only, rimpiazziamo con la Library standard
	            if ( !/\S/.test( content ) ) {
	                content = buildNewIndexContent();
	            } else {
	                // Pagina già popolata: aggiungiamo semplicemente una nuova voce in fondo
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

    function createNewPlaylist( api, username, humanName, coverTitle ) {
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

    function getUserPlaylists( api, username ) {
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


	// Salva nel wikitesto l'ordine dei brani corrente (drag & drop)
	// Salva nel wikitesto l'ordine dei brani corrente (drag & drop)
	// e riordina anche il blocco .tta-playlist-artworks di conseguenza
	// Salva nel wikitesto l'ordine dei brani corrente (drag & drop)
	// e riordina anche il blocco .tta-playlist-artworks di conseguenza
	function savePlaylistOrder( api, playlistTitle, $playlistDiv ) {
	    // 1) Leggi l'ordine attuale dai <li> del player
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

	        // Usiamo il titolo così com'è (con gli stessi spazi del wikitesto)
	        tracks.push( {
	            fileTitle: fileTitle,
	            extra: extra || null
	        } );
	    } );

	    if ( !tracks.length ) {
	        mw.notify( 'No tracks found to save order.', { type: 'warn' } );
	        return;
	    }

	    // 2) Leggi il wikitesto della pagina
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

	        // Trova il blocco <div class="tta-playlist" ...>...</div>
	        // Uso [\s\S]* (greedy) per prendere TUTTO il contenuto fino alla vera </div> della playlist
	        var divRe = /(<div[^>]*class="tta-playlist"[^>]*>)([\s\S]*)(<\/div>)/;
	        var mDiv = divRe.exec( content );
	        if ( !mDiv ) {
	            throw new Error( 'Playlist div not found in page content' );
	        }

	        var open = mDiv[ 1 ];
	        var inner = mDiv[ 2 ];
	        var close = mDiv[ 3 ];

	        // 2a) Estrai la mappa artworks esistente
	        var artworkRe = /<div\s+class="tta-playlist-artworks"[^>]*>([\s\S]*?)<\/div>/;
	        var spanRe = /<span[^>]*data-file="([^"]+)"[^>]*data-artwork="([^"]+)"[^>]*>\s*<\/span>/g;
	        var artworkMatch = artworkRe.exec( inner );
	        var artworkInner = artworkMatch ? artworkMatch[ 1 ] : '';
	        var mSpan;

	        // mappa: chiave canonica (underscore) → { fileAttr, artAttr }
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

	        // 2b) Ripulisci inner da vecchio blocco artworks e da vecchie righe *
	        if ( artworkMatch ) {
	            inner = inner.replace( artworkRe, '' );
	        }
	        inner = inner.replace( /^\s*\*.*$/gm, '' );

	        // 3) Ricostruisci le righe * [[File:...]] // extra nel nuovo ordine
	        var lines = tracks.map( function ( t ) {
	            var line = '* [[' + t.fileTitle + ']]';
	            if ( t.extra ) {
	                line += ' // ' + t.extra;
	            }
	            return line;
	        } );

	        var bulletBlock = '\n' + lines.join( '\n' ) + '\n';

	        // 4) Ricostruisci il blocco artworks seguendo lo stesso ordine dei brani
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

	        // 5) Ricompone l'inner: righe + blocco artworks
	        var newInner = bulletBlock + newArtworkBlock;
	        if ( newInner.charAt( 0 ) !== '\n' ) {
	            newInner = '\n' + newInner;
	        }

	        var newContent = content.replace( divRe, open + newInner + close );

	        // 6) Salva la pagina
	        return api.postWithToken( 'csrf', {
	            action: 'edit',
	            title: playlistTitle,
	            text: newContent,
	            summary: 'Reorder playlist tracks',
	            format: 'json'
	        } );
	    } ).catch( function ( err ) {
	        console.error( '[TTA] savePlaylistOrder error:', err );
	        mw.notify( 'Error while saving playlist order. Check console.', { type: 'error' } );
	    } );
	}


    // ------------------------------------------------------------
    // 3) Rename playlist (usa il titolo umano, non wgTitle)
    // ------------------------------------------------------------

    function renamePlaylist( api, username, playlistTitle ) {
        // 1) leggi contenuto della pagina per ricavare il nome corrente "umano"
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
                mw.notify( 'Cannot rename: playlist page has no content.', { type: 'error' } );
                return;
            }

            var content = page.revisions[ 0 ].content || '';
            var currentName;

            // a) prova dal primo heading == ... ==
            var mHeading = content.match( /==\s*(.+?)\s*==/ );
            if ( mHeading && mHeading[ 1 ] ) {
                currentName = mHeading[ 1 ];
            } else {
                // b) prova da data-title del div .tta-playlist
                var mDiv = content.match(
                    /<div[^>]*class="tta-playlist"[^>]*data-title="([^"]*)"/
                );
                if ( mDiv && mDiv[ 1 ] ) {
                    currentName = mDiv[ 1 ];
                } else {
                    // c) fallback: ultimo pezzo del titolo pagina, con _ → spazio
                    var parts = playlistTitle.split( '/' );
                    currentName = parts[ parts.length - 1 ].replace( /_/g, ' ' );
                }
            }

            // 2) chiedi il nuovo nome usando il titolo umano
            var newName = window.prompt( 'New playlist name:', currentName );
            if ( !newName ) {
                return;
            }
            newName = newName.trim();
            if ( !newName || newName === currentName ) {
                return;
            }

            // 3) aggiorna contenuto pagina (heading + data-title)
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
                // 4) aggiorna indice User:<username>/Playlists
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
                        'Playlist renamed to "' + newName + '".',
                        { type: 'success' }
                    );
                    // Ricarica per aggiornare titolo e player
                    window.location.reload();
                } );
            } );
        } ).catch( function ( err ) {
            console.error( '[TTA] renamePlaylist error:', err );
            mw.notify( 'Error while renaming playlist.', { type: 'error' } );
        } );
    }

    // ------------------------------------------------------------
    // 3b) Helper per gestione index e cancellazioni
    // ------------------------------------------------------------

    function removePlaylistFromIndex( api, username, playlistTitle ) {
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

            // Elimina la riga che contiene [[playlistTitle|...]]
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

    function deletePlaylistPermanently( api, username, playlistTitle ) {
        // Prova a cancellare la pagina (per sysop funzionerà, per altri
        // potrebbe fallire con errore permessi).
        return api.postWithToken( 'csrf', {
            action: 'delete',
            title: playlistTitle,
            reason: 'Delete playlist permanently',
            format: 'json'
        } ).then( function () {
            return removePlaylistFromIndex( api, username, playlistTitle );
        } ).then( function () {
            mw.notify(
                'Playlist deleted permanently.',
                { type: 'success' }
            );
            // Torna alla pagina indice delle playlist
            window.location.href = mw.util.getUrl( 'User:' + username + '/Playlists' );
        } ).catch( function ( err ) {
            console.error( '[TTA] deletePlaylist error:', err );
            var msg = 'Error while deleting playlist.';
            if ( err && err.error && err.error.info ) {
                msg += ' ' + err.error.info;
            }
            mw.notify( msg, { type: 'error' } );
        } );
    }
	
	// Soft-delete per utenti normali: niente "action=delete", solo edit + rimozione dall'indice
	function softDeletePlaylistForUser( api, username, playlistTitle ) {
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
	            'Playlist removed from your library.',
	            { type: 'success' }
	        );
	        // Torna alla pagina indice delle playlist
	        window.location.href = mw.util.getUrl( 'User:' + username + '/Playlists' );
	    } ).catch( function ( err ) {
	        console.error( '[TTA] softDeletePlaylistForUser error:', err );
	        var msg = 'Error while deleting playlist.';
	        if ( err && err.error && err.error.info ) {
	            msg += ' ' + err.error.info;
	        }
	        mw.notify( msg, { type: 'error' } );
	    } );
	}
	

	/**
	 * Aggiunge questa playlist all'indice dell'utente (User:Name/Playlists)
	 * se non è già presente.
	 *
	 * @param {mw.Api} api
	 * @param {string} userName  es. "WikiSysop"
	 * @param {string} playlistPage es. "User:WikiSysop/Playlists/Featured_Tune"
	 * @param {string} playlistLabel etichetta umana, es. "Featured Tune"
	 */
	function addPlaylistToIndex( api, userName, playlistPage, playlistLabel ) {
	    if ( !userName ) {
	        return $.Deferred().reject( 'no-user' ); // niente utente loggato
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

	        // evita duplicati: cerca qualsiasi linea con quella pagina
	        var escapedPage = escapeRegex( playlistPage.replace( / /g, '_' ) );
	        var re = new RegExp( '\\*\\s*\\[\\[' + escapedPage + '(\\|[^\\]]*)?\\]\\]' );

	        if ( re.test( content ) ) {
	            // già presente, niente da fare
	            return;
	        }

	        if ( !exists ) {
	            // pagina indice nuova di zecca
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
    // 4) Dialog OOUI "Add to playlist" + helper conferme
    // ------------------------------------------------------------

    var ttaPlaylistWindowManager;

    function getTtaPlaylistWindowManager() {
        if ( !ttaPlaylistWindowManager ) {
            ttaPlaylistWindowManager = new OO.ui.WindowManager();
            $( document.body ).append( ttaPlaylistWindowManager.$element );
        }
        return ttaPlaylistWindowManager;
    }

    // piccolo helper: dialog di conferma / scelta con OOUI
    function openConfirmDialog( config ) {
        var wm = getTtaPlaylistWindowManager();
        var messageDialog = new OO.ui.MessageDialog();

        wm.addWindows( [ messageDialog ] );

        // Se non vengono passate azioni custom, usa il classico Cancel / OK
        var actions = config.actions || [
            {
                action: 'cancel',
                label: config.cancelLabel || 'Cancel',
                flags: [ 'safe', 'close' ]
            },
            {
                action: 'accept',
                label: config.okLabel || 'OK',
                flags: config.okFlags || [ 'primary', 'progressive' ]
            }
        ];

        var winPromise = wm.openWindow( messageDialog, {
            title: config.title || 'Confirm',
            message: config.message || '',
            actions: actions
        } );

        // Ritorna la stringa "action" del bottone cliccato (o null)
        return winPromise.closed.then( function ( data ) {
            return data && data.action || null;
        } );
    }

    function TtaPlaylistDialog( config ) {
        TtaPlaylistDialog.super.call( this, config );
        this.trackMeta = config.trackMeta || {};
        this.api = new mw.Api();
        this.username = mw.config.get( 'wgUserName' );
        this.chosenPlaylist = null;   // { title, name } dalla lista custom
        this.$existingList = null;    // container DOM per le playlist esistenti
    }
    OO.inheritClass( TtaPlaylistDialog, OO.ui.ProcessDialog );

    TtaPlaylistDialog.static.name = 'ttaPlaylistDialog';
    TtaPlaylistDialog.static.title = 'Add to playlist';
	TtaPlaylistDialog.static.closeAction = 'cancel';   // 👈 AGGIUNGI QUESTA RIGA
    TtaPlaylistDialog.static.actions = [
        {
            action: 'cancel',
            label: 'Cancel',
            flags: [ 'safe', 'close' ]
        },
        {
            action: 'add',
            label: 'Add',
            flags: [ 'primary', 'progressive' ]
        }
    ];

    TtaPlaylistDialog.prototype.initialize = function () {
        TtaPlaylistDialog.super.prototype.initialize.call( this );

        var dialog = this;

        // ---- Existing playlists tab (lista custom) ----
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
            this.useArtworkCheckbox,
            {
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

    TtaPlaylistDialog.prototype.getBodyHeight = function () {
        return 260;
    };

    // Carica le playlist esistenti e riempie la lista custom
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
	                        'Select a playlist or switch to "Create new playlist".',
	                        { type: 'error' }
	                    );
	                    return;
	                }

	                return appendTrackToPlaylist(
	                    api,
	                    pl.title,
	                    track.fileTitle,
	                    track.extra,
	                    track.artworkTitle   // artwork del brano
	                ).then( function () {
	                    mw.notify(
	                        'Track added to "' + pl.name + '".',
	                        { type: 'success' }
	                    );
	                    dialog.close( { action: 'done' } );
	                } );
	            }

	            // ---- Create new playlist ----
	            if ( activeName === 'create' ) {
	                if ( !newName ) {
	                    mw.notify( 'Please enter a playlist name.', { type: 'error' } );
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
	                        track.artworkTitle   // artwork del brano
	                    ).then( function () {
	                        mw.notify(
	                            'Playlist "' + info.name + '" created and track added.',
	                            { type: 'success' }
	                        );
	                        dialog.close( { action: 'done' } );
	                    } );
	                } );
	            }

	            mw.notify( 'Unknown action.', { type: 'error' } );
	        } );
	    }

	    // 2) Tutte le altre azioni (X, Cancel, ESC, ecc.) chiudono la dialog
	    return new OO.ui.Process( function () {
	        // 'action' può essere 'cancel', 'close' o undefined,
	        // a noi interessa solo chiudere pulitamente.
	        dialog.close( { action: action || 'cancel' } );
	    } );
	};

    // Funzione helper per aprire la dialog
    function openAddToPlaylistDialog( fileTitle, extra, artworkTitle ) {
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
    // 5) UI owner: remove track + menu ⋮ nelle pagine playlist
    // ------------------------------------------------------------

    /**
     * Attacca i bottoni "🗑" ai brani della playlist.
     * Usa l’array di file salvato su $playlistDiv.data('ttaPlaylistFiles').
     */
    function attachRemoveButtons( api, playlistTitle, $playlistDiv ) {
        var fileTitles = $playlistDiv.data( 'ttaPlaylistFiles' ) || [];

        // Prima prova sui track della card moderna
        var $tracks = $playlistDiv.find( '.tta-playlist-wrapper .tta-playlist-track' );
        if ( !$tracks.length ) {
            // fallback: player potrebbe avere messo le tracce direttamente sotto .tta-playlist
            $tracks = $playlistDiv.find( '.tta-playlist-track' );
        }
        if ( !$tracks.length ) {
            // fallback legacy: nessun player → usiamo direttamente i <li>
            $tracks = $playlistDiv.find( 'li' );
        }

        $tracks.each( function ( index ) {
            var $item = $( this );

            // Evita doppio binding
            if ( $item.data( 'ttaRemoveBound' ) ) {
                return;
            }

	    var fileTitle =
	        $item.attr( 'data-filetitle' ) ||
	        $item.data( 'filetitle' ) ||
	        fileTitles[ index ] ||
	        null;

            // Fallback: prova a leggere un eventuale link File:… dentro l’item
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
                    actions: [
                        { action: 'cancel', label: 'Cancel', flags: [ 'safe', 'close' ] },
                        { action: 'remove', label: 'Remove', flags: [ 'primary', 'destructive' ] }
                    ]
                } ).then( function ( action ) {
                    if ( action !== 'remove' ) {
                        return;
                    }

                    removeTrackFromPlaylist( api, playlistTitle, fileTitle )
                        .then( function () {
                            mw.notify( 'Track removed from playlist.', { type: 'success' } );
                            $item.remove();
                        } )
                        .catch( function ( err ) {
                            console.error( '[TTA] removeTrack error:', err );
                            mw.notify( 'Error while removing track.', { type: 'error' } );
                        } );
                } );
            } );

            $item.append( $btn );
            $item.data( 'ttaRemoveBound', true );
        } );
    }

    function enhancePlaylistOwnerUI( $root ) {
        if ( !$root || !$root.jquery ) {
            $root = $( document );
        }

        var userName = mw.config.get( 'wgUserName' );
        var pageName = mw.config.get( 'wgPageName' ); // es. "User:WikiSysop/Playlists/Harpers_..."
        var prefix   = 'User:' + userName + '/Playlists/';
		// Gruppi dell'utente corrente (es. ["*", "user", "autoconfirmed", "sysop", ...])
		var userGroups = mw.config.get( 'wgUserGroups' ) || [];
		var isSysop = userGroups.indexOf( 'sysop' ) !== -1;
		
        if ( !userName || !pageName ) {
            return;
        }

        // Cerchiamo la playlist principale della pagina
        var $playlistDiv = $root.find( '.tta-playlist' ).first();
        if ( !$playlistDiv.length ) {
            console.log( '[TTA] ownerUI: nessuna .tta-playlist trovata nella pagina' );
            return;
        }

        // Evita di rieseguire se hook wikipage.content scatta più volte
        if ( $playlistDiv.data( 'ttaOwnerUiBound' ) ) {
            return;
        }
        $playlistDiv.data( 'ttaOwnerUiBound', true );

        // --- 1) Estraggo SUBITO la lista dei file dalla UL “raw”
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
            var fileTitle = decodeURIComponent( m[ 1 ] ); // es. "File:Napoleon_crossing_the_Rhine.mp3"
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

        // --- 2) Dopo che il player ha finito il rendering, aggiungiamo
        //       sia i cestini sia la barra con il menu ⋮ (se owner)
        setTimeout( function () {
            var api = new mw.Api();
			
			
            // Cestini sulle tracce (come prima)
            attachRemoveButtons( api, pageName, $playlistDiv );


            // Se non è il proprietario, per ora niente barra owner (in futuro qui metteremo un "+"
            // dedicato alle playlist altrui). Per adesso usciamo.
            if ( !isOwner ) {
                return;
            }

            // Barra "Your playlist" + menu
            var $ownerBar = $( '<div>' )
                .addClass( 'tta-playlist-ownerbar' );

            var $ownerLabel = $( '<span>' )
                .addClass( 'tta-playlist-ownerbar-label' )
                .text( 'Your playlist' );

			    // Pulsante "+" per aggiungere/ripristinare la playlist nella propria libreria
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
			            actions: [
			                { action: 'cancel', label: 'Cancel', flags: [ 'safe', 'close' ] },
			                { action: 'add',    label: 'Add to my library', flags: [ 'primary' ] }
			            ]
			        } ).then( function ( action ) {
			            if ( action === 'add' ) {
			                var playlistLabel = $playlistDiv.data( 'title' ) || pageName;
			                addPlaylistToIndex( api, userName, pageName, playlistLabel );
			            }
			        } );
			    } );
								

				// --- MENU INTERNO: QUATTRO BOTTONI (icone testuali) ---

				// "Save order" con simbolo di riordinamento
				var saveOrderBtn = new OO.ui.ButtonWidget( {
				    label: '↕ Save order',
				    framed: false,
				    classes: [ 'tta-playlist-menu-item' ]
				} );

				// Rename con matita
				var renameBtn = new OO.ui.ButtonWidget( {
				    label: '✏ Rename',
				    framed: false,
				    classes: [ 'tta-playlist-menu-item' ]
				} );

				// Remove from profile con stellina "vuota"
				var removeProfileBtn = new OO.ui.ButtonWidget( {
				    label: '☆ Remove from profile',
				    framed: false,
				    classes: [ 'tta-playlist-menu-item' ]
				} );

				// Delete permanently con X piena
				var deleteBtn = new OO.ui.ButtonWidget( {
				    label: '✕ Delete permanently',
				    framed: false,
				    classes: [ 'tta-playlist-menu-item' ]
				} );

				// Contenitore verticale del menu
				var $innerMenu = $( '<div>' )
				    .addClass( 'tta-playlist-menu' )
				    .append( saveOrderBtn.$element )
				    .append( renameBtn.$element )
				    .append( removeProfileBtn.$element )
				    .append( deleteBtn.$element );

            // Popup che contiene il menu
            var popupWidget = new OO.ui.PopupWidget( {
                $content: $innerMenu,
                padded: false,
                align: 'right',
                autoClose: true,
                head: false,
                classes: [ 'tta-playlist-popup' ]
            } );

            // Bottone ⋮ che apre/chiude il popup
            var menuButton = new OO.ui.ButtonWidget( {
                label: '⋮',
                title: 'Playlist options',
                framed: false,
                classes: [ 'tta-playlist-menu-button' ]
            } );

            menuButton.on( 'click', function () {
                popupWidget.toggle();
            } );

            // --- AZIONI DEI TRE BOTTONI DEL MENU ---

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
                    actions: [
                        { action: 'keep',   label: 'Cancel',              flags: [ 'safe', 'close' ] },
                        { action: 'remove', label: 'Remove from profile', flags: [ 'primary', 'destructive' ] }
                    ]
                } ).then( function ( action ) {
                    if ( action === 'remove' ) {
                        removePlaylistFromIndex( api, userName, pageName );
                    }
                } );
            } );

			// Delete (hard per sysop, soft per utenti normali)
			deleteBtn.on( 'click', function () {
			    popupWidget.toggle( false );

			    var title = isSysop ? 'Delete permanently' : 'Delete playlist';
			    var message = isSysop
			        ? 'Delete this playlist page permanently? This cannot be undone.'
			        : 'Delete this playlist from your library? The page content will be replaced by a small stub and removed from your library.';

			    openConfirmDialog( {
			        title: title,
			        message: message,
			        actions: [
			            { action: 'keep',   label: 'Cancel',          flags: [ 'safe', 'close' ] },
			            { action: 'delete', label: isSysop ? 'Delete' : 'Delete playlist', flags: [ 'primary', 'destructive' ] }
			        ]
			    } ).then( function ( action ) {
			        if ( action === 'delete' ) {
			            if ( isSysop ) {
			                // hard delete → action=delete
			                deletePlaylistPermanently( api, userName, pageName );
			            } else {
			                // soft delete → edit + remove from index
			                softDeletePlaylistForUser( api, userName, pageName );
			            }
			        }
			    } );
			} );


			// Save order
			saveOrderBtn.on( 'click', function () {
			    popupWidget.toggle( false );

			    mw.notify( 'Saving new track order…', { type: 'info' } );

			    savePlaylistOrder( api, pageName, $playlistDiv )
			        .then( function () {
			            mw.notify( 'Track order saved.', { type: 'success' } );
			            // opzionale: ricarica la pagina per rifare tutto dal nuovo markup
			            // location.reload();
			        } )
			        .catch( function ( err ) {
			            console.error( '[TTA] savePlaylistOrder error:', err );
			            mw.notify( 'Error while saving track order.', { type: 'error' } );
			        } );
			} );


	    // Contenitore pulsanti: "+" e ⋮
	    var $menuContainer = $( '<span>' )
	        .addClass( 'tta-playlist-menu-container' )
	        .append( addBtn.$element )
	        .append( menuButton.$element )
	        .append( popupWidget.$element );

	    $ownerBar.append( $ownerLabel, $menuContainer );

			// Inseriamo la barra all'inizio del card grafico (.tta-playlist-wrapper)
			var $wrapper = $playlistDiv.find( '.tta-playlist-wrapper' ).first();

			if ( $wrapper.length ) {
			    // Barra come prima riga dentro il box grigio
			    $wrapper.prepend( $ownerBar );
			} else {
			    // Fallback: se per qualche motivo il wrapper non esiste,
			    // usa il comportamento vecchio
			    $playlistDiv.before( $ownerBar );
			}

			console.log( '[TTA] ownerUI: barra owner + menu ⋮ aggiunti' );
        }, 1000 ); // stesso delay dei cestini
    }

    // ------------------------------------------------------------
    // Init gadget
    // ------------------------------------------------------------

    function init( $content ) {
        if ( !$content || !$content.jquery ) {
            $content = $( document );
        }
        enhanceEmbeds( $content );            // bottone ♪ +
        enhancePlaylistOwnerUI( $content );   // remove + menu ⋮ sulle playlist dell'utente
    }

    $( function () {
        init();
    } );

    mw.hook( 'wikipage.content' ).add( init );

}( mediaWiki, jQuery ) );
