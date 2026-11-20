// Internal build (D-16): the alarm map is hidden and its basemap tiles are off-origin, so the
// map library is not shipped. Anything that still reaches it fails loudly instead of fetching.
class Unavailable { constructor() { throw new Error('map not available in the Local Console build'); } }
export default { Map: Unavailable, Marker: Unavailable, Popup: Unavailable, NavigationControl: Unavailable };
