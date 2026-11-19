package in.rodix.link;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

// Marks a method of LinkPlugin or one of its LinkFeature classes as callable from the renderer by
// name through LinkPlugin.call(); names are unique across all of them.
// Tauri indexes only @Command methods that take an Invoke; routing every renderer call through one
// Command keeps the handlers as plain (LinkCall) methods instead of one Command each.
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
@interface LinkMethod {}
