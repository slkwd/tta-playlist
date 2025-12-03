/* global mediaWiki, jQuery */
( function ( mw, $ ) {
    'use strict';
    console.log( 'ttaPlaylist Library gadget v1.0.0 loaded' );

    // Esegui solo su pagine utente "libreria playlist"
    var title = mw.config.get( 'wgPageName' ) || '';
    // Esempio: "User:WikiSysop/Playlists"
    if ( mw.config.get( 'wgNamespaceNumber' ) !== 2 ) {
        return;
    }
    if ( !/\/Playlists$/.test( title ) ) {
        return;
    }

    // Attendi il caricamento del contenuto
    $( function () {
        var $content = $( '.mw-parser-output' );
        if ( !$content.length ) {
            return;
        }

        // Trova il titolo "My playlists"
        var $heading = $content.find( 'h2' ).filter( function () {
            return $.trim( $( this ).text() ) === 'My playlists';
        } ).first();

        if ( !$heading.length ) {
            return;
        }

        // Trova la <ul> subito dopo l'heading
        var $ul = $heading.nextAll( 'ul' ).first();
        if ( !$ul.length ) {
            return;
        }

        var playlists = [];
        var seen = Object.create( null );

        // Estrai tutte le playlist dall'elenco
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
                pageTitle: pageTitle,                 // es. "User:Foo/Playlists/Northumberland_..."
                displayTitle: $a.text().trim() || pageTitle
            } );
        } );

        if ( !playlists.length ) {
            return;
        }

        var api = new mw.Api();

        // Scarica i wikitext delle playlist in un'unica chiamata (se possibile)
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

                    // Trova il div tta-playlist
                    var divMatch = content.match(
                        /<div[^>]*class="tta-playlist"[^>]*>/i
                    );
                    if ( divMatch ) {
                        var divTag = divMatch[ 0 ];
                        var titleMatch = divTag.match( /data-title="([^"]*)"/i );
                        var coverMatch = divTag.match( /data-cover="([^"]*)"/i );

                        if ( titleMatch && !pl.displayTitle ) {
                            pl.displayTitle = titleMatch[ 1 ];
                        }
                        pl.coverFile = coverMatch ? coverMatch[ 1 ] : null;
                    } else {
                        pl.coverFile = null;
                    }

                    // Conta i brani: righe che iniziano con "* [[File:..."
                    var trackMatches = content.match(
                        /^\s*\*\s*\[\[\s*File:[^\]]+\]\]/gmi
                    );
                    pl.trackCount = trackMatches ? trackMatches.length : 0;
                } );

                return items;
            } );
        }

        // Dato un set di titoli File:..., recupera le URL delle cover
        function fetchCoverUrls( items ) {
            var files = [];
            var seenFiles = Object.create( null );

            items.forEach( function ( pl ) {
                if ( pl.coverFile && !seenFiles[ pl.coverFile ] ) {
                    seenFiles[ pl.coverFile ] = true;
                    files.push( pl.coverFile );
                }
            } );

            if ( !files.length ) {
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
                        map[ page.title ] = info.thumburl || info.url;
                    }
                } );
                return map;
            } );
        }

        function buildGallery( items, coverMap ) {
            var $gallery = $( '<div>' )
                .addClass( 'tta-playlist-library-gallery' );

            items.forEach( function ( pl ) {
                var href = mw.util.getUrl( pl.pageTitle );
                var $card = $( '<a>' )
                    .addClass( 'tta-playlist-card' )
                    .attr( 'href', href );

                // Cover
                var $cover = $( '<div>' )
                    .addClass( 'tta-playlist-card-cover' );

                var coverUrl = pl.coverFile && coverMap[ pl.coverFile ];
                if ( coverUrl ) {
                    $( '<img>' )
                        .attr( {
                            src: coverUrl,
                            alt: pl.displayTitle + ' cover'
                        } )
                        .appendTo( $cover );
                } else {
                    // Placeholder semplice (iniziale o nota)
                    var initial = ( pl.displayTitle || '?' ).charAt( 0 );
                    $( '<div>' )
                        .addClass( 'tta-playlist-card-cover-placeholder' )
                        .text( initial )
                        .appendTo( $cover );
                }

                // Corpo
                var $body = $( '<div>' )
                    .addClass( 'tta-playlist-card-body' );

                $( '<div>' )
                    .addClass( 'tta-playlist-card-title' )
                    .text( pl.displayTitle )
                    .appendTo( $body );

                var metaText = '';
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

            // Inserisci la gallery subito dopo l'heading "My playlists"
            $gallery.insertAfter( $heading );

            // (Opzionale) aggiungi una classe al contenuto, per eventuale CSS futuro
            $content.addClass( 'tta-playlist-library-has-gallery' );
        }

        // Pipeline: scarica contenuti playlist, poi cover, poi costruisci la gallery
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
