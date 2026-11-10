package cache;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CacheTest {
    @Test
    void answers() {
        assertEquals(42, Cache.answer());
    }
}
